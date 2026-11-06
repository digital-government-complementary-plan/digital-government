/* ============================================================
   sampleData.js
   ------------------------------------------------------------
   デモ用サンプルデータの定義。
   ここでは配列として切り出し、app.js からは
   AppModules.SampleData.get(index) を呼ぶだけにする。

   各デモはそのまま「入力の出発点」としても使える。例えば
   「配偶者・兄弟姉妹」のデモを読み込んだ後、兄弟の一人が死亡した
   ことにして代襲者(甥姪)を追加していく、といった編集が可能。

   非嫡出子デモ(4)は、平成25年9月4日以前に相続が開始した場合に
   限られる様式のため、被相続人の死亡日を実際に判定可能な日付
   （平成24年）にしてある。
   ============================================================ */

(function () {
  "use strict";

  window.AppModules = window.AppModules || {};

  let idCounter = 1;
  function nextId() { return idCounter++; }

  const samples = [

    // 0: 配偶者・子
    function sample0() {
      return {
        deceased: { name: '法務太郎', birth: '昭和24年4月12日', death: '令和7年6月1日', lastAddr: '東京都世田谷区上北沢三丁目5番12号', lastHoseki: '東京都杉並区高円寺南四丁目12番地5' },
        spouse: { role: '（妻）', name: '法務花子', birth: '昭和26年9月3日', addr: '東京都世田谷区上北沢三丁目5番12号', isApplicant: true, isCreator: true, isSuccessor: true },
        children: [
          { id: nextId(), role: '（長男）', name: '法務一郎', birth: '昭和52年11月20日', death: '', addr: '神奈川県横浜市港北区日吉本町二丁目8番15号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] },
          { id: nextId(), role: '（長女）', name: '法務優子', birth: '昭和55年2月14日', death: '', addr: '埼玉県さいたま市浦和区高砂三丁目6番1号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] },
          { id: nextId(), role: '（二男）', name: '法務二郎', birth: '昭和58年7月9日', death: '', addr: '千葉県船橋市本町四丁目10番22号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] }
        ],
        siblings: [],
        parents: []
      };
    },

    // 1: 配偶者・兄弟姉妹
    function sample1() {
      return {
        deceased: { name: '法務太郎', birth: '昭和30年8月8日', death: '令和7年6月1日', lastAddr: '大阪府堺市堺区南瓦町3番1号', lastHoseki: '大阪府堺市西区鳳東町一丁目2番地3' },
        spouse: { role: '（妻）', name: '法務花子', birth: '昭和32年1月20日', addr: '大阪府堺市堺区南瓦町3番1号', isApplicant: true, isCreator: true, isSuccessor: true },
        children: [],
        siblings: [
          { id: nextId(), role: '（兄）', name: '法務一郎', birth: '昭和28年2月10日', addr: '京都府京都市伏見区深草西浦町五丁目3番7号', isApplicant: false, isCreator: false, isSuccessor: true, isHalfBlood: false, halfBloodParent: 'father', substitutes: [] },
          { id: nextId(), role: '（弟）', name: '法務次郎', birth: '昭和33年10月2日', addr: '奈良県奈良市三条大路一丁目1番4号', isApplicant: false, isCreator: false, isSuccessor: true, isHalfBlood: false, halfBloodParent: 'father', substitutes: [] },
          { id: nextId(), role: '（妹）', name: '法務優子', birth: '昭和36年6月30日', addr: '和歌山県和歌山市湊本町二丁目4番9号', isApplicant: false, isCreator: false, isSuccessor: true, isHalfBlood: false, halfBloodParent: 'father', substitutes: [] }
        ],
        parents: []
      };
    },

    // 2: 配偶者・親
    function sample2() {
      return {
        deceased: { name: '法務花子', birth: '昭和45年5月5日', death: '令和7年6月1日', lastAddr: '愛知県名古屋市中区栄三丁目10番5号', lastHoseki: '愛知県豊田市元城町四丁目6番地2' },
        spouse: { role: '（夫）', name: '法務太郎', birth: '昭和43年1月15日', addr: '愛知県名古屋市中区栄三丁目10番5号', isApplicant: true, isCreator: true, isSuccessor: true },
        children: [],
        siblings: [],
        parents: [
          { id: nextId(), role: '（母）', name: '法務町子', birth: '昭和18年6月2日', death: '', addr: '岐阜県岐阜市金町五丁目8番1号', isApplicant: false, isCreator: false, isSuccessor: true }
        ]
      };
    },

    // 3: 半血兄弟姉妹
    function sample3() {
      return {
        deceased: { name: '法務太郎', birth: '昭和31年3月3日', death: '令和7年6月1日', lastAddr: '北海道札幌市中央区南一条西十丁目2番5号', lastHoseki: '北海道函館市末広町8番地3' },
        spouse: { role: '（妻）', name: '法務花子', birth: '昭和33年7月7日', addr: '北海道札幌市中央区南一条西十丁目2番5号', isApplicant: false, isCreator: false, isSuccessor: true },
        children: [],
        siblings: [
          { id: nextId(), role: '（異母兄）', name: '法務一郎', birth: '昭和25年11月11日', addr: '', isApplicant: false, isCreator: false, isSuccessor: true, isHalfBlood: true, halfBloodParent: 'father', substitutes: [] },
          { id: nextId(), role: '（弟）', name: '法務次郎', birth: '昭和34年4月4日', addr: '北海道旭川市三条通九丁目3番2号', isApplicant: true, isCreator: true, isSuccessor: true, isHalfBlood: false, halfBloodParent: 'father', substitutes: [] },
          { id: nextId(), role: '（異父妹）', name: '法務優子', birth: '昭和37年9月9日', addr: '北海道釧路市黒金町七丁目5番1号', isApplicant: false, isCreator: false, isSuccessor: true, isHalfBlood: true, halfBloodParent: 'mother', substitutes: [] }
        ],
        parents: []
      };
    },

    // 4: 非嫡出子（平成25年9月4日以前に相続が開始している場合に限る様式）
    function sample4() {
      return {
        deceased: { name: '法務太郎', birth: '昭和20年10月10日', death: '平成24年3月1日', lastAddr: '新潟県長岡市大手通二丁目6番1号', lastHoseki: '新潟県新潟市中央区古町通五番町5番地8' },
        spouse: { role: '（妻）', name: '法務花子', birth: '昭和23年12月2日', addr: '新潟県長岡市大手通二丁目6番1号', isApplicant: true, isCreator: true, isSuccessor: true },
        children: [
          { id: nextId(), role: '（長男）', name: '法務一郎', birth: '昭和45年4月4日', death: '', addr: '長野県松本市中央一丁目4番7号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] },
          { id: nextId(), role: '（長女）', name: '法務優子', birth: '昭和47年8月8日', death: '', addr: '富山県富山市桜町一丁目1番3号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] },
          { id: nextId(), role: '（子）', name: '法務三郎', birth: '昭和50年1月25日', death: '', addr: '石川県金沢市香林坊二丁目5番9号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: true, substitutes: [] }
        ],
        siblings: [],
        parents: []
      };
    },

    // 5: 養子
    function sample5() {
      return {
        deceased: { name: '法務太郎', birth: '昭和22年6月6日', death: '令和7年6月1日', lastAddr: '福岡県福岡市西区姪浜二丁目4番1号', lastHoseki: '福岡県北九州市小倉北区城内2番地1' },
        spouse: { role: '（妻）', name: '法務花子', birth: '昭和25年3月15日', addr: '福岡県福岡市西区姪浜二丁目4番1号', isApplicant: true, isCreator: true, isSuccessor: true },
        children: [
          { id: nextId(), role: '（長男）', name: '法務一郎', birth: '昭和48年10月1日', death: '', addr: '福岡県久留米市東町3番2号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] },
          { id: nextId(), role: '（長女）', name: '法務優子', birth: '昭和51年5月5日', death: '', addr: '熊本県熊本市中央区水道町7番4号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] },
          { id: nextId(), role: '（養子）', name: '法務二郎', birth: '昭和55年12月12日', death: '', addr: '佐賀県佐賀市駅前中央一丁目8番9号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: true, isIllegitimate: false, substitutes: [] }
        ],
        siblings: [],
        parents: []
      };
    },

    // 6: 代襲相続（再代襲を含む3世代の例。長男が死亡し孫が代襲したが、
    //    その孫もさらに死亡していたため、ひ孫が再代襲するケース）
    function sample6() {
      return {
        deceased: { name: '法務太郎', birth: '昭和18年2月2日', death: '令和7年6月1日', lastAddr: '広島県広島市中区紙屋町一丁目3番2号', lastHoseki: '岡山県岡山市北区駅元町1番地1' },
        spouse: { role: '（妻）', name: '法務花子', birth: '昭和21年8月8日', addr: '広島県広島市中区紙屋町一丁目3番2号', isApplicant: true, isCreator: true, isSuccessor: true },
        children: [
          {
            id: nextId(), role: '（長男）', name: '法務一郎', birth: '昭和43年4月5日', death: '平成20年3月15日',
            addr: '広島県呉市中通二丁目5番3号', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false,
            substitutes: [
              {
                id: nextId(), role: '（孫・代襲者）', name: '法務三郎', birth: '平成2年7月7日', death: '平成28年8月20日',
                addr: '山口県下関市南部町5番1号', isApplicant: false, isCreator: false, isSuccessor: true,
                substitutes: [
                  { id: nextId(), role: '（ひ孫・再代襲者）', name: '法務四郎', birth: '平成25年3月3日', death: '', addr: '山口県山口市中央一丁目2番3号', isApplicant: true, isCreator: false, isSuccessor: true, substitutes: [] }
                ]
              }
            ]
          },
          { id: nextId(), role: '（二男）', name: '法務二郎', birth: '昭和46年6月6日', death: '', addr: '島根県松江市殿町8番地1', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false, substitutes: [] }
        ],
        siblings: [],
        parents: []
      };
    },

    // 7: 数次相続（死亡した相続人）。法務局の記載例と同じ構成。
    //    被相続人（法務太郎）の死亡後、相続人（長男の法務春夫）が登記をしないまま死亡し、
    //    その相続人（妻の法務温子・子の法務一郎）が相続する。長男は被相続人の死亡後に亡くなっているため、
    //    代襲相続ではなく数次相続になる。
    function sample7() {
      return {
        deceased: { name: '法務太郎', birth: '大正7年5月5日', death: '平成2年3月21日', lastAddr: '兵庫県姫路市本町68番地', lastHoseki: '兵庫県姫路市二階町100番地' },
        spouse: { role: '', name: '', birth: '', addr: '', isApplicant: false, isCreator: false, isSuccessor: true },
        children: [
          {
            id: nextId(), role: '（長男）', name: '法務春夫', birth: '昭和15年3月3日', death: '令和7年6月20日',
            addr: '兵庫県姫路市飾磨区細江2番地', isApplicant: false, isCreator: false, isSuccessor: true, isAdopted: false, isIllegitimate: false,
            substitutes: [
              { id: nextId(), role: '（妻）', name: '法務温子', birth: '昭和17年4月4日', death: '', addr: '兵庫県姫路市飾磨区細江2番地', isApplicant: true, isCreator: true, isSuccessor: true, substitutes: [] },
              { id: nextId(), role: '（子）', name: '法務一郎', birth: '昭和45年12月1日', death: '', addr: '大阪府大阪市中央区本町三丁目2番1号', isApplicant: false, isCreator: false, isSuccessor: true, substitutes: [] }
            ]
          }
        ],
        siblings: [],
        parents: []
      };
    }
  ];

  window.AppModules.SampleData = {
    count: samples.length,
    get(index) {
      const fn = samples[index];
      if (!fn) return null;
      return fn();
    }
  };
})();

/* ------------------------------------------------------------
   相続財産（不動産・預貯金など）のデモ。
   相続関係のデモを選ぶと、最初のデモ（土地）が自動で入力される。
   財産ごとのデモは、各財産の入力欄の「デモ入力」で個別に切り替えられる。
------------------------------------------------------------ */
window.AppModules = window.AppModules || {};
window.AppModules.AssetDemos = [
  { label: "土地（宅地）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "東京法務局世田谷出張所",
    fields: { postal: "156-0057", location: "東京都世田谷区上北沢三丁目", lotNo: "5番12", category: "宅地", area: "165.28", assessedValue: "12,345,678" } },
  { label: "建物（居宅）", kind: "building", office: "〇〇地方法務局〇〇支局", expectOffice: "東京法務局世田谷出張所",
    fields: { postal: "156-0057", location: "東京都世田谷区上北沢三丁目5番地12", lotNo: "5番12", category: "居宅", structure: "木造スレート葺2階建", area: "1階 62.10㎡ 2階 48.30㎡", assessedValue: "8,765,432" } },
  { label: "区分建物（マンション・敷地権付）", kind: "unit", office: "〇〇地方法務局〇〇支局", expectOffice: "東京法務局港出張所",
    fields: { postal: "105-0011", location: "東京都港区芝公園四丁目2番8", buildingName: "法務タワー芝公園", lotNo: "2番8の301", unitName: "301号",
      category: "居宅", structure: "鉄筋コンクリート造1階建", area: "65.43", assessedValue: "10,500,000", hasSiteRight: true, landRightValue: "3,456,000",
      siteRights: [{ symbol: "1", location: "東京都港区芝公園四丁目", lotNo: "2番8", category: "宅地", area: "1234.56", right: "所有権", ratio: "10000分の123" }] } },
  { label: "土地（評価額100万円以下・免税の対象）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "長野地方法務局佐久支局",
    fields: { postal: "385-0022", location: "長野県佐久市岩村田", lotNo: "1234番5", category: "山林", area: "330.00", assessedValue: "850,000" } },
  { label: "土地（被相続人が共有持分1/2を所有）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "横浜地方法務局港北出張所",
    fields: { postal: "223-0061", location: "神奈川県横浜市港北区日吉本町二丁目", lotNo: "8番15", category: "宅地", area: "198.35", assessedValue: "6,000,000", rightKind: "share", deceasedShare: "1/2" } },
  { label: "土地（評価額1,000,900円：課税価格100万円で免税）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "名古屋法務局豊田支局",
    fields: { postal: "470-0372", location: "愛知県豊田市猿投町", lotNo: "1055番", category: "畑", area: "412.00", assessedValue: "1,000,900" } },
  { label: "預貯金（普通預金）", kind: "deposit", office: "",
    fields: { assetName: "〇〇銀行〇〇支店の普通預金（口座番号〇〇〇〇〇〇〇）" } },
  { label: "預貯金（定期預金）", kind: "deposit", office: "",
    fields: { assetName: "〇〇信用金庫〇〇支店の定期預金（口座番号〇〇〇〇〇〇〇）" } },
  { label: "預貯金（ゆうちょ銀行）", kind: "deposit", office: "",
    fields: { assetName: "ゆうちょ銀行の通常貯金（記号〇〇〇〇〇　番号〇〇〇〇〇〇〇〇）" } },
  { label: "株式（証券会社に預けているもの）", kind: "other", otherKind: "stock", office: "",
    fields: { stockIssuer: "〇〇株式会社（証券コード〇〇〇〇）", stockCount: "1,000", stockInstitution: "〇〇証券株式会社〇〇支店 口座番号〇〇〇〇〇〇〇" } },
  { label: "株式（非上場会社）", kind: "other", otherKind: "stock", office: "",
    fields: { stockIssuer: "〇〇商事株式会社（非上場）", stockCount: "200", stockInstitution: "" } },
  { label: "自動車（普通乗用車）", kind: "other", otherKind: "car", office: "",
    fields: { carName: "トヨタ プリウス", carRegNo: "〇〇 300 あ 12-34", carVin: "ZVW50-〇〇〇〇〇〇〇" } },
  { label: "自動車（軽自動車）", kind: "other", otherKind: "car", office: "",
    fields: { carName: "スズキ ハスラー", carRegNo: "〇〇 580 い 56-78", carVin: "MR52S-〇〇〇〇〇〇" } },
  { label: "それ以外（貸金庫の内容物）", kind: "other", otherKind: "other", office: "",
    fields: { assetName: "〇〇銀行〇〇支店の貸金庫に保管されている一切の物品" } },
  { label: "それ以外（ゴルフ会員権）", kind: "other", otherKind: "other", office: "",
    fields: { assetName: "〇〇カントリークラブのゴルフ会員権（会員番号〇〇〇〇）" } },
  { label: "土地（北海道函館市）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "函館地方法務局",
    fields: { postal: "040-0063", location: "北海道函館市若松町", lotNo: "12番3", category: "宅地", area: "220.15", assessedValue: "4,800,000" } },
  { label: "土地（大阪市北区）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "大阪法務局北出張所",
    fields: { postal: "530-0001", location: "大阪府大阪市北区梅田一丁目", lotNo: "3番6", category: "宅地", area: "90.25", assessedValue: "48,000,000" } },
  { label: "土地（新潟市北区：管轄が2つの登記所に分かれる）", kind: "land", office: "〇〇地方法務局〇〇支局", expectAmbiguous: ["新潟地方法務局", "新潟地方法務局新発田支局"],
    fields: { postal: "950-3301", location: "新潟県新潟市北区葛塚", lotNo: "2345番", category: "宅地", area: "301.20", assessedValue: "5,200,000" } },
  { label: "土地（東京都西多摩郡瑞穂町）", kind: "land", office: "〇〇地方法務局〇〇支局", expectOffice: "東京法務局西多摩支局",
    fields: { postal: "190-1221", location: "東京都西多摩郡瑞穂町大字箱根ケ崎", lotNo: "888番2", category: "宅地", area: "175.00", assessedValue: "7,300,000" } }
];
