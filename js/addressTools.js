/* 住所・所在の文字列を、郵便番号から作り直す共通の部品（通信しない）。
   不動産の所在も、人の住所も、この部品を使う。js/offices.js・js/postal.js・js/postaltown.js を使う。 */
(function () {
  const AM = (window.AppModules = window.AppModules || {});
  const O = AM.Offices, P = AM.Postal || null, T = AM.PostalTown || null;
  // 郵便番号の表記ゆれ（七ヶ浜・七ケ浜、須惠・須恵、郡の有無、島名つきの村名）をそろえるための正規化
  const cityKey = (t) => String(t || "").replace(/[ヶヵｹ]/g, "ケ").replace(/惠/g, "恵").replace(/^(三宅島|八丈島)/, "").replace(/^.+?郡/, "");
  // 郵便番号の市区町村名を、市区町村のプルダウンにある名前にそろえる（そろわなければ、そのまま）
  function canonicalCity(pf, raw) {
    const m = O.municipalityOf(pf, raw);
    if (m.len) return raw;                                    // そのまま選べる（政令指定都市の区つきも含む）
    const key = cityKey(raw);
    for (const g of O.municipalityGroups(pf)) for (const it of g.items) if (cityKey(it.text) === key) return it.text;
    return raw;
  }
  // 所在の先頭の市区町村の長さ。政令指定都市で、プルダウンが「千葉市」までのときは、続く区まで含める
  function muniSpan(pf, rest) {
    const m = O.municipalityOf(pf, rest);
    if (!m.len) return 0;
    let len = m.len;
    if (/市$/.test(rest.slice(0, len))) { const w = rest.slice(len).match(/^[\u4E00-\u9FFF々ヶケ]{1,4}区/); if (w) len += w[0].length; }
    return len;
  }
  // 先頭の都道府県を、選んだものに替える（外すときは、都道府県だけを取る）
  function setPref(text, name) {
    const oldPref = O.detectPref(text);
    let rest = O.afterPref(text);
    if (name && name !== oldPref) {
      // 前の都道府県の市区町村（東京都の「世田谷区」など）が、新しい都道府県のものでなければ、外す
      const old = oldPref ? O.municipalityOf(oldPref, rest) : { len: 0 };
      const cur = O.municipalityOf(name, rest);
      if (!cur.len) {
        if (old.len) rest = rest.slice(old.len);
        else if (!oldPref) { const any = O.municipalityOfAny(rest); if (any.len) rest = rest.slice(any.len); }
      }
    }
    return (name || "") + rest;
  }
  // 都道府県のあとの市区町村を、郵便番号の市区町村に替える（もう同じなら、そのまま）
  function setCity(text, pf, city) {
    const t = canonicalCity(pf, city);
    let rest = O.afterPref(text).replace(/^\s+/, "");
    if (rest.startsWith(t)) return pf + rest;
    const span = muniSpan(pf, rest);
    if (span) rest = rest.slice(span);
    else rest = rest.replace(/^〇(市|区|町|村|郡)?/, "");
    return pf + t + rest;
  }
  // 7桁の郵便番号が決める字名（町域）まで入れる。すでに同じ字名まで入っていれば、そのまま（丁目・番地が続いていてもよい）。
  // 違う字名なら、郵便番号の字名に替える（前の字名に続いていた丁目・番地は、別の場所のものなので外す）
  function setTown(text, pf, city, town) {
    const t = canonicalCity(pf, city);
    const rest = O.afterPref(text).replace(/^\s+/, "");
    return pf + (rest.startsWith(t + town) ? rest : t + town);
  }
  // 郵便番号から、住所・所在の文字列を作り直す。郵便番号で決まらなければ、そのまま返す
  function fillFromPostal(text, postal) {
    const found = P ? P.lookup(postal) : { pref: "", city: "" };
    const pf = found.pref || O.prefFromPostal(postal);          // 全国の郵便番号の表で決まらなければ、上3桁の表を使う
    if (!pf) return text || "";
    let loc = text || "";
    if (O.detectPref(loc) !== pf) loc = setPref(loc, pf);
    if (!found.city) return loc;
    const town = T ? T.town(postal) : "";
    return town ? setTown(loc, pf, found.city, town) : setCity(loc, pf, found.city);
  }
  AM.AddressTools = { cityKey, canonicalCity, muniSpan, setPref, setCity, setTown, fillFromPostal };
})();
