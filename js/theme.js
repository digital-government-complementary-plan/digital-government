/* ============================================================
   theme.js
   ------------------------------------------------------------
   ダークモードの切替を担当する。
   ・初回表示時は localStorage の保存値を優先し、なければ
     OS/ブラウザの prefers-color-scheme（システム設定）に従う。
   ・切替ボタンで手動オーバーライドでき、その選択を localStorage
     に保存して次回以降も維持する。
   ・実際に色を変えるのは css/style.css 側（CSSカスタムプロパティ）
     で、このスクリプトは <html> の data-theme 属性を
     "light" / "dark" に切り替えるだけ。
   ・一覧図(SVGの用紙部分)は印刷される紙面そのものを表すため、
     テーマに関わらず常に白のまま固定している（style.css側の設計）。
   ============================================================ */

(function () {
  "use strict";

  const STORAGE_KEY = "houseki-system-theme";

  function getStoredTheme() {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch (e) {
      // localStorageが使えない環境（プライベートモード等）では
      // 保存を諦めてシステム設定にフォールバックする。
      return null;
    }
  }

  function getSystemPreference() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.textContent = theme === "dark" ? "☀️ ライトモード" : "🌙 ダークモード";
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch (e) {
      // 保存に失敗しても切替自体は継続する
    }
    applyTheme(next);
  }

  // 初期テーマの適用（保存値 > システム設定の順）。
  // このスクリプトは <head> 内でボタンより先に実行されるため、
  // ここでの applyTheme はボタンのラベル更新には間に合わない
  // （data-theme属性の設定はちらつき防止のためこの時点で行う）。
  applyTheme(getStoredTheme() || getSystemPreference());

  // ボタン要素が使えるようになった時点で、現在のテーマに
  // 合わせてラベルを再同期する。
  document.addEventListener("DOMContentLoaded", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(current);
  });

  // システム設定が変化した場合、ユーザーが手動選択していなければ追従する
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!getStoredTheme()) {
        applyTheme(e.matches ? "dark" : "light");
      }
    });
  }

  window.ThemeManager = { toggleTheme, applyTheme };
})();
