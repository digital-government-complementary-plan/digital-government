/* ============================================================
   diagramEngine.js
   ------------------------------------------------------------
   法定相続情報一覧図・相続関係説明図のSVG描画エンジン。Vue等の
   UIフレームワークに依存しない純粋なモジュールとして分離。
   app.js からは
     AppModules.DiagramEngine.render(svgElement, state, options)
   の1関数だけを呼び出す。

   ------------------------------------------------------------
   タイトル・以下余白・作成者欄は「パーツ」として、どの相続パターン
   （子・親・兄弟姉妹・配偶者のみ）であっても常に同じ手順で呼び出す。
   パターンごとの分岐は家系図本体の内部処理だけに閉じ込め、
   ヘッダー・フッターがパターン分岐の影響を受けて表示されなくなる、
   という種類のバグを構造的に防ぐ。

   ------------------------------------------------------------
   法定相続情報一覧図と相続関係説明図の違い（options.isCertifiedで
   切り替える。既定はtrue=法定相続情報一覧図）:

   ・法定相続情報一覧図は登記官の認証を受ける公的書類のため、
     「相続に関係のない情報」を書けない、様式が厳格、という制約が
     ある。この制約は isCertified=true のときだけ適用する:
       - 死亡していて代襲者もいない人物は法定相続情報一覧図に記載しない。
       - 被代襲者は氏名・住所を記載せず死亡日のみ。
       - 非嫡出子の生母、半血兄弟姉妹のもう一方の親は、氏名を
         記載せず「（女）」「〔女２〕」等の続柄のみ。
       - 改ざん防止のための「以下余白」を記載する。
   ・相続関係説明図は私的な書類で様式に制限がないため、
     isCertified=false のときはこれらの制約をすべて外し、
     ・死亡していて代襲者がいない人物も氏名入りで記載する
     ・被代襲者も氏名・住所を記載する
     ・生母やもう一方の親も、名前が入力されていればその氏名を記載する
     ・相続放棄や遺産分割による取得の有無などの注記を記載できる
     ・「以下余白」は記載しない
     ようにする。

   state = {
     deceased: { name, birth, death, lastAddr, lastHoseki },
     spouse:   { role, name, birth, addr, isApplicant, isCreator, isSuccessor } | null,
     children: [ { role, name, birth, death, addr, isApplicant, isCreator,
                   isAdopted, isIllegitimate, isSuccessor, substitutes:[ 再帰可 ] } ],
     siblings: [ { role, name, birth, addr, isApplicant, isCreator, isHalfBlood,
                   halfBloodParent: 'father'|'mother', isSuccessor, substitutes:[ 非再帰 ] } ],
     parents:  [ { role, name, birth, death, addr, isApplicant, isCreator, isSuccessor } ],
     creator:  { date, isAgentMode, agentAddr, agentName },
     extraRelations: { illegitimateMotherName, fatherOtherPartnerName, motherOtherPartnerName }
   }
   ============================================================ */

(function () {
  "use strict";

  window.AppModules = window.AppModules || {};

  const NS = "http://www.w3.org/2000/svg";

  const LEFT_X = 150;
  const RIGHT_X = 500;
  const COL_GAP = 20;
  const BOX_W = 210;
  const HEIR_BOX_W = 180;
  const CONNECTOR_BOX_W = 90;
  const COL_STEP = 230;
  const HEIR_H = 70;
  const TOP_Y = 130;
  const MIN_CANVAS_W = 694;
  const MIN_CANVAS_H = 890;
  const RIGHT_MARGIN = 50;

  const ERA_START_YEAR = { "明治": 1868, "大正": 1912, "昭和": 1926, "平成": 1989, "令和": 2019 };
  const ILLEGITIMATE_CUTOFF = { year: 2013, month: 9, day: 4 };
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
  function checkIllegitimatePatternDate(deathStr) {
    const parsed = parseJapaneseEraDate(deathStr);
    if (!parsed) return null;
    if (parsed.year !== ILLEGITIMATE_CUTOFF.year) return parsed.year < ILLEGITIMATE_CUTOFF.year;
    if (parsed.month !== ILLEGITIMATE_CUTOFF.month) return parsed.month < ILLEGITIMATE_CUTOFF.month;
    return parsed.day <= ILLEGITIMATE_CUTOFF.day;
  }

  // ------------------------------------------------------------
  // 非嫡出子の母（複数対応）
  // ------------------------------------------------------------
  // 母が異なる非嫡出子を同じ母にまとめてしまわないよう、母は
  // extraRelations.illegitimateMothers = [{id, name}] の配列で持ち、
  // 各子は motherId でどの母の子かを指す（未設定・不明なら先頭の母）。
  // 図では、同じ母の子が隣り合うよう並べ替えたうえで、母ごとに
  // 被相続人との線と子への幹線を分けて描く。
  function getMothers(state) {
    const extra = state.extraRelations || {};
    if (Array.isArray(extra.illegitimateMothers) && extra.illegitimateMothers.length > 0) {
      return extra.illegitimateMothers;
    }
    return [{ id: "mother1", name: extra.illegitimateMotherName || "" }];
  }
  function motherIndexOf(child, mothers) {
    const i = mothers.findIndex((m) => m.id === child.motherId);
    return i >= 0 ? i : 0;
  }
  function isQualifyingIllegitimate(child, state) {
    return !!child.isIllegitimate && checkIllegitimatePatternDate(state.deceased.death) !== false;
  }
  // 嫡出子を先に、続いて母ごとに非嫡出子をまとめる（元の順序は保つ）。
  function sortChildrenByMother(state) {
    const mothers = getMothers(state);
    return state.children
      .map((c, i) => ({ c, i, g: isQualifyingIllegitimate(c, state) ? 1 + motherIndexOf(c, mothers) : 0 }))
      .sort((a, b) => (a.g - b.g) || (a.i - b.i))
      .map((x) => x.c);
  }

  function createSvgEl(parent, tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      el.setAttribute(k, v);
    }
    if (text) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }

  function stackColumn(centerX, startY, entities, boxW) {
    const nodes = [];
    let y = startY;
    entities.forEach((e) => {
      const node = Object.assign({}, e, { x: centerX, y: y + e.h / 2, w: boxW });
      nodes.push(node);
      y += e.h + COL_GAP;
    });
    return nodes;
  }

  function verticalSpanOf(nodes) {
    if (nodes.length === 0) return null;
    const top = Math.min(...nodes.map((n) => n.y - n.h / 2));
    const bottom = Math.max(...nodes.map((n) => n.y + n.h / 2));
    return { top, bottom, center: (top + bottom) / 2 };
  }

  function centerShorterColumn(leftNodes, rightAllNodes) {
    const leftSpan = verticalSpanOf(leftNodes);
    const rightSpan = verticalSpanOf(rightAllNodes);
    if (!leftSpan || !rightSpan) return;
    const leftH = leftSpan.bottom - leftSpan.top;
    const rightH = rightSpan.bottom - rightSpan.top;
    if (leftH < rightH) {
      const shift = rightSpan.center - leftSpan.center;
      leftNodes.forEach((n) => { n.y += shift; });
    } else if (rightH < leftH) {
      const shift = leftSpan.center - rightSpan.center;
      rightAllNodes.forEach((n) => { n.y += shift; });
    }
  }

  const MAX_PAGE_CONTENT_HEIGHT = 580;

  // ノード内の文字が枠からはみ出さない高さ。
  // 縦線は枠の辺に接して引かれるため、〔相続人〕などの行が枠の外に出ると
  // 文字の上に線がかかってしまう。行数に応じて枠を伸ばして防ぐ。
  // （drawNode の行の配置: 見出し y+18、氏名 y+38、以降の情報行は y+56 から15ずつ）
  function neededNodeHeight(n) {
    const lines = (n.honseki ? 1 : 0) + (n.addr ? 1 : 0) + (n.birth ? 1 : 0) + (n.death ? 1 : 0) + (n.mark ? 1 : 0);
    const lastBaseline = lines > 0 ? 56 + 15 * (lines - 1) : 38;
    return lastBaseline + 16;
  }
  // 数次相続で亡くなった人（deathKind === "after"）は、被相続人の死亡時点では相続人。
  // 法定相続情報一覧図では普通の相続人として（死亡年月日つきで）書き、その人の相続人は書かない
  // （その人を被相続人とする法定相続情報一覧図を別に作るため）。相続関係説明図では、その人の相続人も続けて書く。
  function effSubs(item, isCertified) {
    return item.deathKind === "after" && isCertified ? [] : (item.substitutes || []);
  }
  function itemNodeHeight(item, boxH, isCertified) {
    const hasSubs = effSubs(item, isCertified).length > 0;
    const suppress = hasSubs && isCertified;
    return Math.max(boxH, neededNodeHeight({
      addr: suppress ? "" : item.addr, birth: suppress ? "" : item.birth, death: item.death,
      mark: !isCertified && !hasSubs && !item.death
    }));
  }

  function estimateBlockHeight(item, boxH, isCertified) {
    const subs = effSubs(item, isCertified);
    if (item.death && subs.length === 0 && isCertified && item.deathKind !== "after") return 0;
    const ownH = itemNodeHeight(item, boxH, isCertified);
    if (subs.length === 0) return ownH;
    let subTotal = 0;
    subs.forEach((sub, i) => {
      if (i > 0) subTotal += COL_GAP;
      subTotal += estimateBlockHeight(sub, HEIR_H, isCertified);
    });
    return Math.max(ownH, subTotal);
  }

  function paginateItems(items, boxH, maxHeight, isCertified) {
    const pages = [];
    let current = [];
    let currentHeight = 0;
    items.forEach((item) => {
      const h = estimateBlockHeight(item, boxH, isCertified);
      if (h === 0) { current.push(item); return; }
      const addGap = current.some((it) => estimateBlockHeight(it, boxH, isCertified) > 0) ? COL_GAP : 0;
      if (currentHeight + addGap + h > maxHeight && current.length > 0) {
        pages.push(current);
        current = [item];
        currentHeight = h;
      } else {
        current.push(item);
        currentHeight += addGap + h;
      }
    });
    if (current.length > 0 || pages.length === 0) pages.push(current);
    return pages;
  }

  function buildPages(state, options) {
    const isCertified = !(options && options.isCertified === false);
    const hasChildren = state.children.length > 0;
    const hasParents = state.parents.length > 0;
    const hasSiblings = state.siblings.length > 0;
    let pattern;
    if (hasChildren) pattern = "children";
    else if (hasParents) pattern = "parents";
    else if (hasSiblings) pattern = "siblings";
    else pattern = "coupleOnly";

    if (pattern === "children") {
      state = Object.assign({}, state, { children: sortChildrenByMother(state) });
      const groups = paginateItems(state.children, 80, MAX_PAGE_CONTENT_HEIGHT, isCertified);
      if (groups.length <= 1) return [state];
      return groups.map((g) => Object.assign({}, state, { children: g, siblings: [], parents: [] }));
    }
    if (pattern === "siblings") {
      const groups = paginateItems(state.siblings, 70, MAX_PAGE_CONTENT_HEIGHT, isCertified);
      if (groups.length <= 1) return [state];
      return groups.map((g) => Object.assign({}, state, { siblings: g, children: [], parents: [] }));
    }
    return [state];
  }

  function buildDescendantColumn(items, colX, startY, boxW, boxH, idPrefix, isCertified) {
    let y = startY;
    const directNodes = [];
    let allNodes = [];
    const links = [];

    items.forEach((item, idx) => {
      const subs = effSubs(item, isCertified);
      const hasSubs = subs.length > 0;
      if (item.death && !hasSubs && isCertified && item.deathKind !== "after") { return; }

      const nodeId = idPrefix + "_" + idx;
      const suppressName = hasSubs && isCertified;

      const node = {
        id: nodeId, x: colX, w: boxW,
        isSubstitutedAway: suppressName,
        label: hasSubs ? (item.deathKind === "after" ? item.role : "（被代襲者）") : item.role,
        name: suppressName ? "" : item.name,
        birth: suppressName ? "" : item.birth,
        addr: suppressName ? "" : item.addr,
        death: item.death || "",
        // 申出人は法定相続情報一覧図に固有の概念（保管申出をする人）。
        // 相続関係説明図には申出人という概念がないため出さない。
        isApplicant: (isCertified && !suppressName) ? !!item.isApplicant : false,
        isCreator: suppressName ? false : !!item.isCreator,
        isIllegitimate: item.isIllegitimate,
        motherId: item.motherId,
        isAdopted: item.isAdopted,
        isHalfBlood: item.isHalfBlood,
        // 相続関係説明図は登記ごとに「誰がこの登記で相続するか」を
        // 示す書類のため、〔相続人〕/〔相続しない〕を必ず表示する。
        // 法定相続情報一覧図は法定相続人を示すだけなのでこの区別は書かない。
        // 死亡している人（被代襲者など）は相続人ではないため、どちらの印も付けない。
        // これにより、〔相続人〕の表記が登記申請書の申請人（取得者）と常に一致する。
        successorMark: (!isCertified && !hasSubs && !item.death) ? (item.isSuccessor ? "相続人" : "相続しない") : ""
      };

      const nodeH = itemNodeHeight(item, boxH, isCertified);
      let rowHeight = nodeH;
      let subResult = null;
      if (hasSubs) {
        const nextColX = colX + COL_STEP;
        subResult = buildDescendantColumn(subs, nextColX, y, HEIR_BOX_W, HEIR_H, nodeId, isCertified);
        rowHeight = Math.max(nodeH, subResult.totalHeight);
        const offset = (rowHeight - subResult.totalHeight) / 2;
        if (offset > 0.01) {
          subResult.allNodes.forEach((n) => { n.y += offset; });
        }
      }

      node.h = nodeH;
      node.y = y + rowHeight / 2;
      directNodes.push(node);
      allNodes.push(node);

      if (hasSubs) {
        allNodes.push(...subResult.allNodes);
        links.push({
          from: { x: node.x + node.w / 2, y: node.y },
          targets: subResult.directNodes.map((n) => ({ x: n.x - n.w / 2, y: n.y, node: n }))
        });
        links.push(...subResult.links);
      }
      y += rowHeight + COL_GAP;
    });

    const totalHeight = directNodes.length ? (y - COL_GAP - startY) : 0;
    return { directNodes, allNodes, links, totalHeight };
  }

  // 列内の隣接する2ノードを線でつなぐ（二重線=婚姻線 or 単線）。
  // extendToEdgeがtrueなら、線上の接続点から列の右端まで単線を延長し、
  // 戻り値としてその接続点（＝右方向へ幹線を伸ばす起点）を返す。
  //
  // preferredBusY: 接続先が1人だけの場合にその相手の高さを渡す。
  //   単線（親子関係を示す線）であり、かつその高さがこの縦線の範囲内に
  //   収まっているときは、中点ではなくその高さから水平に出す。こうすると
  //   接続先までが一直線になり、不要に線を曲げずに済む。
  //   婚姻の二重線は様式上その中心から親子線を出すため、この調整はしない。
  function drawVerticalLink(svg, nodeTop, nodeBottom, isDouble, extendToEdge, preferredBusY) {
    if (!nodeTop || !nodeBottom) return null;
    const x1 = nodeTop.x, y1 = nodeTop.y + nodeTop.h / 2;
    const x2 = nodeBottom.x, y2 = nodeBottom.y - nodeBottom.h / 2;
    if (isDouble) {
      createSvgEl(svg, "line", { x1: x1 - 4, y1, x2: x2 - 4, y2, class: "link spouse" });
      createSvgEl(svg, "line", { x1: x1 + 4, y1, x2: x2 + 4, y2, class: "link spouse" });
    } else {
      createSvgEl(svg, "line", { x1, y1, x2, y2, class: "link" });
    }

    let busY = (y1 + y2) / 2;
    if (!isDouble && preferredBusY != null) {
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      if (preferredBusY >= lo && preferredBusY <= hi) busY = preferredBusY;
    }

    if (extendToEdge) {
      const edgeX = nodeTop.x + nodeTop.w / 2;
      createSvgEl(svg, "line", { x1: nodeTop.x, y1: busY, x2: edgeX, y2: busY, class: "link" });
      return { x: edgeX, y: busY };
    }
    return { x: nodeTop.x, y: busY };
  }

  function buildLayout(state, options) {
    const isCertified = !(options && options.isCertified === false);
    const extra = state.extraRelations || {};

    const hasSpouse = !!(state.spouse && state.spouse.name !== "");
    const hasChildren = state.children.length > 0;
    const hasParents = state.parents.length > 0;
    const hasSiblings = state.siblings.length > 0;

    let pattern;
    if (hasChildren) pattern = "children";
    else if (hasParents) pattern = "parents";
    else if (hasSiblings) pattern = "siblings";
    else pattern = "coupleOnly";

    const decedentEntity = {
      role: "decedent",
      h: Math.max(130, neededNodeHeight({ honseki: state.deceased.lastHoseki, addr: state.deceased.lastAddr, birth: state.deceased.birth, death: state.deceased.death })),
      label: "（被相続人）",
      name: state.deceased.name, birth: state.deceased.birth, death: state.deceased.death,
      honseki: state.deceased.lastHoseki, addr: state.deceased.lastAddr,
      isDecedent: true
    };
    const spouseEntity = hasSpouse ? {
      role: "spouse",
      h: Math.max(70, neededNodeHeight({ addr: state.spouse.addr, birth: state.spouse.birth, death: state.spouse.death, mark: !isCertified && !state.spouse.death })),
      label: state.spouse.role,
      name: state.spouse.name, birth: state.spouse.birth, addr: state.spouse.addr,
      death: state.spouse.death || "",
      isApplicant: isCertified ? state.spouse.isApplicant : false,
      isCreator: state.spouse.isCreator,
      successorMark: (!isCertified && !state.spouse.death) ? (state.spouse.isSuccessor ? "相続人" : "相続しない") : ""
    } : null;

    let leftNodes = [];
    let rightNodes = [];
    let rightBusTargets = [];
    let rightCoupleBlock = null;
    let descendantLinks = [];

    if (pattern === "children") {
      const children = sortChildrenByMother(state);
      const mothers = getMothers(state);

      // 実際に使われる母（対象となる非嫡出子がいる母）を、母の並び順で求める
      const usedMotherIdx = [];
      children.forEach((c) => {
        if (!isQualifyingIllegitimate(c, state)) return;
        const mi = motherIndexOf(c, mothers);
        if (!usedMotherIdx.includes(mi)) usedMotherIdx.push(mi);
      });
      usedMotherIdx.sort((a, b) => a - b);
      const multiMother = usedMotherIdx.length > 1;

      const motherEntities = usedMotherIdx.map((mi, k) => {
        const generic = multiMother ? "（女" + toFullWidthDigits(k + 1) + "）" : "（女）";
        return {
          role: "mother-connector", h: 55,
          label: isCertified ? generic : (mothers[mi].name || generic),
          name: "", isConnectorOnly: true
        };
      });

      const leftCore = [];
      if (spouseEntity) leftCore.push(spouseEntity);
      leftCore.push(decedentEntity);
      motherEntities.forEach((m) => leftCore.push(m));
      leftNodes = stackColumn(LEFT_X, TOP_Y, leftCore, BOX_W);

      let i = 0;
      const spouseNode = spouseEntity ? leftNodes[i++] : null;
      const decedentNode = leftNodes[i++];
      const motherNodes = motherEntities.map(() => leftNodes[i++]);

      const result = buildDescendantColumn(children, RIGHT_X, TOP_Y, BOX_W, 80, "child", isCertified);
      rightNodes = result.allNodes;
      descendantLinks = result.links;

      const legitimateTargets = [];
      const targetsByMother = {};
      result.directNodes.forEach((n) => {
        const target = { x: n.x - n.w / 2, y: n.y, node: n };
        if (isQualifyingIllegitimate(n, state)) {
          const mi = motherIndexOf(n, mothers);
          (targetsByMother[mi] = targetsByMother[mi] || []).push(target);
        } else {
          legitimateTargets.push(target);
        }
      });

      const childLeftLinks = [];
      if (legitimateTargets.length > 0) {
        childLeftLinks.push({ fromNodes: [spouseNode, decedentNode], isDouble: true, targets: legitimateTargets });
      }
      usedMotherIdx.forEach((mi, k) => {
        const targets = targetsByMother[mi] || [];
        if (k === 0) {
          childLeftLinks.push({ fromNodes: [decedentNode, motherNodes[0]], isDouble: false, targets });
        } else {
          // 2人目以降の母は、被相続人と1人目の母を結ぶ線の途中から左へ
          // 分岐して下ろす（1人目の母の文字を線が貫かないようにするため）。
          childLeftLinks.push({
            branch: true, index: k, decedentNode,
            firstMotherNode: motherNodes[0], motherNode: motherNodes[k], targets
          });
        }
      });

      centerShorterColumn(leftNodes, rightNodes);

      const allNodes = [...leftNodes, ...rightNodes];
      return {
        pattern, hasSpouse, hasChildren, hasParents, hasSiblings, isCertified,
        leftNodes, rightNodes, rightCoupleBlock: null,
        descendantLinks, leftLinks: childLeftLinks, allNodes
      };
    }

    if (pattern === "parents") {
      const leftCore = state.parents.map((p) => ({
        role: "parent",
        h: Math.max(70, neededNodeHeight({ addr: p.addr, birth: p.birth, death: p.death, mark: !isCertified && !p.death })),
        label: p.role, name: p.name,
        birth: p.birth, death: p.death, addr: p.addr,
        isApplicant: isCertified ? p.isApplicant : false, isCreator: p.isCreator,
        successorMark: (!isCertified && !p.death) ? (p.isSuccessor ? "相続人" : "相続しない") : ""
      }));
      leftNodes = stackColumn(LEFT_X, TOP_Y, leftCore, BOX_W);

      const rightCore = spouseEntity ? [decedentEntity, spouseEntity] : [decedentEntity];
      rightNodes = stackColumn(RIGHT_X, TOP_Y, rightCore, BOX_W);
      rightCoupleBlock = rightNodes;
      const decNode = rightCoupleBlock[0];

      if (leftNodes.length === 1) {
        // 親が1人だけの場合は婚姻の二重線がなく、その中心を考える必要が
        // ないため、被相続人と同じ高さに揃える。こうすれば親から被相続人
        // までを水平な一直線で結べ、不要に線を曲げずに済む。
        leftNodes[0].y = decNode.y;
      } else {
        centerShorterColumn(leftNodes, rightNodes);
      }

      // 幹線の接続先は、上の高さ調整を終えた最終座標から求める。
      rightBusTargets = [{ x: decNode.x - decNode.w / 2, y: decNode.y, node: decNode }];

      const leftLinks = [];
      if (leftNodes.length === 2) {
        leftLinks.push({ fromNodes: [leftNodes[0], leftNodes[1]], isDouble: true, targets: [] });
      }

      const allNodes = [...leftNodes, ...rightNodes];
      return {
        pattern, hasSpouse, hasChildren, hasParents, hasSiblings, isCertified,
        leftNodes, rightNodes, rightCoupleBlock,
        descendantLinks: [], leftLinks, rightBusTargets, allNodes,
        rightCoupleLink: { nodes: rightCoupleBlock, isDouble: true }
      };
    }

    if (pattern === "siblings") {
      const hasFatherSideHalf = state.siblings.some((s) => s.isHalfBlood && s.halfBloodParent === "father");
      const hasMotherSideHalf = state.siblings.some((s) => s.isHalfBlood && s.halfBloodParent === "mother");

      const fatherEntity = { role: "parent-connector", h: 55, label: "〔父〕", isConnectorOnly: true };
      const motherEntity = { role: "parent-connector", h: 55, label: "〔母〕", isConnectorOnly: true };
      const extraFatherEntity = hasFatherSideHalf ? {
        role: "parent-connector", h: 55,
        label: isCertified ? "〔女２〕" : (extra.fatherOtherPartnerName || "〔女２〕"),
        isConnectorOnly: true
      } : null;
      const extraMotherEntity = hasMotherSideHalf ? {
        role: "parent-connector", h: 55,
        label: isCertified ? "〔男２〕" : (extra.motherOtherPartnerName || "〔男２〕"),
        isConnectorOnly: true
      } : null;

      const leftCore = [];
      if (extraFatherEntity) leftCore.push(extraFatherEntity);
      leftCore.push(fatherEntity);
      leftCore.push(motherEntity);
      if (extraMotherEntity) leftCore.push(extraMotherEntity);
      leftNodes = stackColumn(LEFT_X, TOP_Y, leftCore, CONNECTOR_BOX_W);

      let i = 0;
      const extraFatherNode = extraFatherEntity ? leftNodes[i++] : null;
      const fatherNode = leftNodes[i++];
      const motherNode = leftNodes[i++];
      const extraMotherNode = extraMotherEntity ? leftNodes[i++] : null;

      const coupleCore = spouseEntity ? [decedentEntity, spouseEntity] : [decedentEntity];
      const coupleBlock = stackColumn(RIGHT_X, TOP_Y, coupleCore, BOX_W);
      rightCoupleBlock = coupleBlock;

      const startY = coupleBlock[coupleBlock.length - 1].y + coupleBlock[coupleBlock.length - 1].h / 2 + COL_GAP;
      const result = buildDescendantColumn(state.siblings, RIGHT_X, startY, BOX_W, 70, "sib", isCertified);
      rightNodes = [...coupleBlock, ...result.allNodes];
      descendantLinks = result.links;

      const decNode = coupleBlock[0];
      const mainTargets = [{ x: decNode.x - decNode.w / 2, y: decNode.y, node: decNode }];
      const fatherSideTargets = [];
      const motherSideTargets = [];

      let siblingIdx = 0;
      state.siblings.forEach((s) => {
        const subs = s.substitutes || [];
        if (s.death && subs.length === 0 && isCertified) return;
        const n = result.directNodes[siblingIdx++];
        if (!n) return;
        const target = { x: n.x - n.w / 2, y: n.y, node: n };
        if (s.isHalfBlood && s.halfBloodParent === "father") fatherSideTargets.push(target);
        else if (s.isHalfBlood && s.halfBloodParent === "mother") motherSideTargets.push(target);
        else mainTargets.push(target);
      });

      centerShorterColumn(leftNodes, rightNodes);

      // 親の組み合わせごとに縦バスのX位置をずらす。同じ位置に重ねると
      // どの子がどの組み合わせの子なのか判別できなくなるため、
      // 父方のみ共通の系統は左寄り、父母共通（全血）の系統は中央、
      // 母方のみ共通の系統は右寄りに分離する。
      const leftLinks = [
        { fromNodes: [fatherNode, motherNode], isDouble: true, targets: mainTargets, trunkOffset: 0 },
        extraFatherNode ? { fromNodes: [extraFatherNode, fatherNode], isDouble: false, targets: fatherSideTargets, trunkOffset: -45 } : null,
        extraMotherNode ? { fromNodes: [motherNode, extraMotherNode], isDouble: false, targets: motherSideTargets, trunkOffset: 45 } : null
      ].filter(Boolean);

      const allNodes = [...leftNodes, ...rightNodes];
      return {
        pattern, hasSpouse, hasChildren, hasParents, hasSiblings, isCertified,
        leftNodes, rightNodes, rightCoupleBlock,
        descendantLinks, leftLinks, allNodes,
        rightCoupleLink: { nodes: rightCoupleBlock, isDouble: true }
      };
    }

    leftNodes = stackColumn(LEFT_X, TOP_Y, spouseEntity ? [decedentEntity, spouseEntity] : [decedentEntity], BOX_W);
    const leftLinksCouple = leftNodes.length === 2 ? [{ fromNodes: [leftNodes[0], leftNodes[1]], isDouble: true, targets: [] }] : [];
    return {
      pattern, hasSpouse, hasChildren, hasParents, hasSiblings, isCertified,
      leftNodes, rightNodes: [], rightCoupleBlock: null,
      descendantLinks: [], leftLinks: leftLinksCouple, allNodes: [...leftNodes]
    };
  }

  function collectCreatorCandidate(state) {
    if (state.creator && state.creator.isAgentMode) {
      return { addr: state.creator.agentAddr, name: state.creator.agentName };
    }
    const found = { value: null };
    const check = (p) => { if (p && p.isCreator && !found.value) found.value = { addr: p.addr, name: p.name }; };
    const walk = (arr) => (arr || []).forEach((p) => { check(p); walk(p.substitutes); });
    check(state.spouse);
    walk(state.children);
    walk(state.siblings);
    walk(state.parents);
    return found.value;
  }

  function drawFrame(svg, w, h) {
    createSvgEl(svg, "rect", {
      x: 2, y: 2, width: w - 4, height: h - 4,
      fill: "none", stroke: "#e2e8f0", "stroke-width": 1, rx: 4
    });
  }

  // 法務局の記載例では、ページ表記は全角数字（１／２、（２／２）①へ続く）。
  function toFullWidthDigits(n) {
    return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xFEE0));
  }

  function drawTitleHeader(svg, w, deceased, titleSuffixOverride, pageInfo) {
    const suffix = titleSuffixOverride || "法定相続情報";
    const pageSuffix = pageInfo && pageInfo.total > 1 ? ` ${toFullWidthDigits(pageInfo.index + 1)}／${toFullWidthDigits(pageInfo.total)}` : "";
    createSvgEl(svg, "text",
      { x: w / 2, y: 34, "text-anchor": "middle", class: "text-doctitle" },
      `被相続人${deceased.name} ${suffix}${pageSuffix}`);
  }

  const CIRCLED_NUMS = ["①", "②", "③", "④", "⑤"];
  function drawContinuationMark(svg, point, markIndex) {
    if (!point) return;
    createSvgEl(svg, "text",
      { x: point.x - 8, y: point.y - 8, "text-anchor": "middle", class: "text-name" },
      CIRCLED_NUMS[markIndex] || "①");
  }

  // fromPointから各targetへ、直交線で接続する。
  // trunkOffset: 縦バス（分岐の幹）のX位置をずらす量。親の組み合わせが
  //   複数ある場合（半血兄弟姉妹で父母・父＋別の相手・母＋別の相手の
  //   3系統があるなど）、そのままでは各系統の縦バスが同じX位置に
  //   重なってしまい、どの子がどの親の組み合わせから出ているのか
  //   判別できなくなる。系統ごとに別の値を渡して分離する。
  function drawTrunkAndBranches(svg, fromPoint, targets, isHalfBloodLine, trunkOffset) {
    if (!fromPoint || targets.length === 0) return;
    const targetX = targets[0].x;
    const trunkX = fromPoint.x + (targetX - fromPoint.x) / 2 + (trunkOffset || 0);
    createSvgEl(svg, "line", { x1: fromPoint.x, y1: fromPoint.y, x2: trunkX, y2: fromPoint.y, class: "link" });

    if (targets.length === 1) {
      const t = targets[0];
      if (Math.abs(t.y - fromPoint.y) > 0.5) {
        createSvgEl(svg, "line", { x1: trunkX, y1: fromPoint.y, x2: trunkX, y2: t.y, class: "link" });
      }
      createSvgEl(svg, "line", {
        x1: trunkX, y1: t.y, x2: t.x, y2: t.y,
        class: isHalfBloodLine && isHalfBloodLine(t) ? "link half" : "link"
      });
      return;
    }

    const ys = targets.map((t) => t.y);
    const yMin = Math.min(...ys, fromPoint.y);
    const yMax = Math.max(...ys, fromPoint.y);
    createSvgEl(svg, "line", { x1: trunkX, y1: yMin, x2: trunkX, y2: yMax, class: "link" });
    targets.forEach((t) => {
      createSvgEl(svg, "line", {
        x1: trunkX, y1: t.y, x2: t.x, y2: t.y,
        class: isHalfBloodLine && isHalfBloodLine(t) ? "link half" : "link"
      });
    });
  }

  // 2人目以降の母の線。被相続人と1人目の母を結ぶ縦線の中点から左へ出し、
  // 母ごとに少しずつ左へずらした縦線で下ろして、その母の文字の左側に接続する。
  // その母の子への幹線は、直前の母との行間（文字のない位置）から右へ出す。
  function drawBranchLink(svg, link) {
    const dec = link.decedentNode, m0 = link.firstMotherNode, mk = link.motherNode;
    const xTrunk = dec.x - 85 - 20 * (link.index - 1);
    const yJoin = ((dec.y + dec.h / 2) + (m0.y - m0.h / 2)) / 2;
    createSvgEl(svg, "line", { x1: dec.x, y1: yJoin, x2: xTrunk, y2: yJoin, class: "link" });
    createSvgEl(svg, "line", { x1: xTrunk, y1: yJoin, x2: xTrunk, y2: mk.y, class: "link" });
    const halfText = Math.max(30, String(mk.label || "").length * 7 + 6);
    createSvgEl(svg, "line", { x1: xTrunk, y1: mk.y, x2: mk.x - halfText, y2: mk.y, class: "link" });
    if (link.targets && link.targets.length > 0) {
      const yGap = mk.y - mk.h / 2 - COL_GAP / 2;
      const edgeX = dec.x + dec.w / 2;
      createSvgEl(svg, "line", { x1: xTrunk, y1: yGap, x2: edgeX, y2: yGap, class: "link" });
      drawTrunkAndBranches(svg, { x: edgeX, y: yGap }, link.targets, null);
    }
  }

  function drawLeftLinks(svg, leftLinks) {
    (leftLinks || []).forEach((link) => {
      if (link.branch) { drawBranchLink(svg, link); return; }
      const [a, b] = link.fromNodes;
      // 配偶者がいない場合（子のみ等）は、被相続人の右端から直接子へ幹線を引く。
      if (!a && b) {
        if (link.targets && link.targets.length > 0) {
          drawTrunkAndBranches(svg, { x: b.x + b.w / 2, y: b.y }, link.targets, null, link.trunkOffset);
        }
        return;
      }
      const hasTargets = link.targets && link.targets.length > 0;
      // 接続先が1人だけなら、縦線上のその相手と同じ高さから水平に出して
      // 一直線にする（単線の場合のみ。二重線は中心から出す様式のため対象外）
      const preferredBusY = (hasTargets && link.targets.length === 1) ? link.targets[0].y : null;
      const bus = drawVerticalLink(svg, a, b, link.isDouble, hasTargets, preferredBusY);
      if (hasTargets && bus) {
        drawTrunkAndBranches(svg, bus, link.targets, null, link.trunkOffset);
      }
    });
  }

  function drawNode(svg, node) {
    const x = node.x - node.w / 2;
    const y = node.y - node.h / 2;

    if (node.isConnectorOnly) {
      createSvgEl(svg, "text", { x: node.x, y: node.y + 5, "text-anchor": "middle", class: "text-name" }, node.label);
      return;
    }

    createSvgEl(svg, "rect", { x, y, width: node.w, height: node.h, class: "node-rect" });
    createSvgEl(svg, "text", { x: node.x, y: y + 18, "text-anchor": "middle", class: "text-label" }, node.label);

    if (node.isSubstitutedAway) {
      if (node.death) {
        createSvgEl(svg, "text", { x: node.x, y: y + 40, "text-anchor": "middle", class: "text-info" }, "死亡 " + node.death);
      }
      return;
    }

    let nameText = node.name;
    if (node.isApplicant) nameText += "（申出人）";
    createSvgEl(svg, "text", { x: node.x, y: y + 38, "text-anchor": "middle", class: "text-name" }, nameText);

    let infoY = y + 56;
    if (node.honseki) {
      createSvgEl(svg, "text", { x: node.x, y: infoY, "text-anchor": "middle", class: "text-info addr" }, "本籍 " + node.honseki);
      infoY += 15;
    }
    if (node.addr) {
      createSvgEl(svg, "text", { x: node.x, y: infoY, "text-anchor": "middle", class: "text-info addr" }, "住所 " + node.addr);
      infoY += 15;
    }
    if (node.birth) {
      createSvgEl(svg, "text", { x: node.x, y: infoY, "text-anchor": "middle", class: "text-info" }, "出生 " + node.birth);
      infoY += 15;
    }
    if (node.death) {
      createSvgEl(svg, "text", { x: node.x, y: infoY, "text-anchor": "middle", class: "text-info" }, "死亡 " + node.death);
      infoY += 15;
    }
    if (node.successorMark) {
      const cls = node.successorMark === "相続人" ? "text-info note successor" : "text-info note";
      createSvgEl(svg, "text", { x: node.x, y: infoY, "text-anchor": "middle", class: cls }, "〔" + node.successorMark + "〕");
    }
  }

  function drawCreatorBlock(svg, creatorTopY, state) {
    const creatorInfo = collectCreatorCandidate(state);
    createSvgEl(svg, "text", { x: 40, y: creatorTopY, class: "text-info", "font-size": "11" }, "作成日： " + (state.creator.date || ""));
    createSvgEl(svg, "text", { x: 40, y: creatorTopY + 22, class: "text-info", "font-size": "11" }, "作成者：");
    createSvgEl(svg, "text", { x: 110, y: creatorTopY + 22, class: "text-info", "font-size": "11" },
      "住所 " + (creatorInfo ? creatorInfo.addr || "" : ""));
    createSvgEl(svg, "text", { x: 320, y: creatorTopY + 22, class: "text-info", "font-size": "11" },
      "氏名 " + (creatorInfo ? creatorInfo.name || "" : ""));   // 作成者は記名のみ（令和3年4月1日から、押印は不要）
  }

  function drawBottomMargin(svg, w, y) {
    createSvgEl(svg, "text",
      { x: w / 2, y, "text-anchor": "middle", class: "text-label", fill: "#94a3b8" },
      "以下余白");
  }

  function drawContinuationNote(svg, w, y, nextPageInfo, markIndex) {
    createSvgEl(svg, "text",
      { x: w / 2, y, "text-anchor": "middle", class: "text-label" },
      `（${toFullWidthDigits(nextPageInfo.index + 1)}／${toFullWidthDigits(nextPageInfo.total)}）${CIRCLED_NUMS[markIndex] || "①"}へ続く`);
  }

  function render(svg, state, options) {
    if (!svg) return;
    svg.innerHTML = "";
    options = options || {};
    const isCertified = options.isCertified !== false;
    const pageIndex = options.pageIndex || 0;
    const pageTotal = options.pageTotal || 1;
    const isLastPage = pageIndex >= pageTotal - 1;
    const isFirstPage = pageIndex === 0;

    const layout = buildLayout(state, { isCertified });

    const maxNodeRight = Math.max(60, ...layout.allNodes.map((n) => n.x + n.w / 2));
    const canvasW = Math.max(MIN_CANVAS_W, maxNodeRight + RIGHT_MARGIN);
    const maxNodeBottom = Math.max(0, ...layout.allNodes.map((n) => n.y + n.h / 2));

    const noteY = maxNodeBottom + 35;
    const yohakuY = (pageTotal > 1 && !isLastPage) ? noteY + 26 : noteY;
    // 「以下余白」と作成者欄は、登記官の認証を受ける法定相続情報一覧図に
    // 固有のもの。相続関係説明図は私的な添付書類であり、作成日・作成者を
    // 記載する様式ではないため、どちらも描画しない。
    const creatorTopY = yohakuY + (isCertified ? 45 : 0);
    const canvasH = Math.max(MIN_CANVAS_H, creatorTopY + (isCertified ? 80 : 40));

    svg.setAttribute("viewBox", `0 0 ${canvasW} ${canvasH}`);

    drawFrame(svg, canvasW, canvasH);
    drawTitleHeader(svg, canvasW, state.deceased, options.titleOverride, pageTotal > 1 ? { index: pageIndex, total: pageTotal } : null);

    drawLeftLinks(svg, layout.leftLinks);
    if (layout.rightCoupleLink) {
      drawVerticalLink(svg, layout.rightCoupleLink.nodes[0], layout.rightCoupleLink.nodes[1], layout.rightCoupleLink.isDouble, false);
    }
    if (layout.rightBusTargets && layout.rightBusTargets.length > 0) {
      const leftBus = { x: layout.leftNodes[0].x + layout.leftNodes[0].w / 2, y: verticalSpanOf(layout.leftNodes).center };
      drawTrunkAndBranches(svg, leftBus, layout.rightBusTargets, null);
    }
    layout.descendantLinks.forEach((link) => {
      drawTrunkAndBranches(svg, link.from, link.targets, null);
    });
    layout.allNodes.forEach((node) => drawNode(svg, node));

    if (pageTotal > 1 && !isFirstPage) {
      const markPoint = { x: layout.leftNodes[0].x + layout.leftNodes[0].w / 2, y: verticalSpanOf(layout.leftNodes).center };
      drawContinuationMark(svg, markPoint, 0);
    }
    if (pageTotal > 1 && !isLastPage) {
      drawContinuationNote(svg, canvasW, noteY, { index: pageIndex + 1, total: pageTotal }, 0);
    }
    if (isCertified) {
      drawBottomMargin(svg, canvasW, yohakuY);
    }
    // 作成日・作成者は法定相続情報一覧図のみ。相続関係説明図には記載しない。
    if (isCertified && isLastPage) {
      drawCreatorBlock(svg, creatorTopY, state);
    }
  }

  window.AppModules.DiagramEngine = { render, buildLayout, buildPages, checkIllegitimatePatternDate };
})();
