/* ============================================================
   substituteEditor.js
   ------------------------------------------------------------
   代襲相続人を編集するための再帰的Vueコンポーネント。
   子の系統（直系卑属）は民法上、再代襲・再々代襲が認められて
   いるため、代襲者自身がさらに代襲者を持てるよう、この
   コンポーネントは自分自身（substitute-editor）を再帰的に
   呼び出す。

   兄弟姉妹の代襲者（甥姪）にはさらなる代襲は認められないため、
   呼び出し側で allow-recursive="false" を渡し、「さらに代襲者を
   追加」ボタン自体を表示しないことで法律上の制限を反映する。
   ただし、その代襲者（甥姪）自身が死亡している場合は、それ以上
   代襲できない以上、相続に関係する人がいなくなるため、法定相続情報一覧図には
   記載されない（diagramEngine.js側で除外される）。そのため死亡日
   欄自体は allowRecursive の値に関わらず常に表示する。

   props経由で状態操作用の関数（app.js側で定義）を受け取り、
   このコンポーネント自身は状態を直接持たない（表示と、渡された
   関数の呼び出しに徹する）。
   ============================================================ */

(function () {
  "use strict";

  window.AppModules = window.AppModules || {};

  window.AppModules.SubstituteEditorComponent = {
    name: "substitute-editor",
    props: {
      substitutes: { type: Array, required: true },
      parentObj: { type: Object, required: true },
      isExpandedFn: { type: Function, required: true },
      toggleFn: { type: Function, required: true },
      addFn: { type: Function, required: true },
      removeFn: { type: Function, required: true },
      toggleCreatorFn: { type: Function, required: true },
      isSuccessorFn: { type: Function, default: null },
      setSuccessorFn: { type: Function, default: null },
      patternName: { type: String, default: "" },
      showIchiranzu: { type: Boolean, default: true },
      creatorPerson: { type: Object, default: null },
      caseLinkedFn: { type: Function, default: null },
      toggleCaseFn: { type: Function, default: null },
      deathKindFn: { type: Function, default: null },
      allowRecursive: { type: Boolean, default: true },
      compactDeadFn: { type: Function, default: null },
      deadApi: { type: Object, default: null },
      title: { type: String, default: "代襲相続人" }
    },
    methods: {
      onCreatorChange(sub) {
        this.toggleCreatorFn(sub);
      },
      // 被代襲者（法定相続情報一覧図では死亡年月日しか表示されない人）かどうか。そうなら入力欄を減らす
      isCompact(sub) {
        return !!(this.compactDeadFn && this.compactDeadFn(sub));
      }
    },
    template: `
      <div v-if="substitutes.length > 0" class="sub-card">
        <div class="sub-card-title">{{ title }}</div>
        <div v-for="(sub, si) in substitutes" :key="sub.id" class="sub-item">
          <div class="sub-item-header" @click="toggleFn(sub.id)">
            <span class="sub-item-who">
              <span class="sub-item-label">{{ sub.role }}</span>
              <input type="text" class="person-item-name-input" v-model="sub.name" placeholder="氏名を入力" aria-label="氏名" @click.stop>
              <label v-if="deadApi" class="chk dead-check" @click.stop><input type="checkbox" :checked="!!sub.death" @change="deadApi.toggle(sub, $event)"><span>死亡</span></label>
            </span>
            <button class="btn btn-danger" @click.stop="removeFn(parentObj, si)">削除</button>
          </div>
          <div v-if="isExpandedFn(sub.id)" class="person-detail" @click.stop>
            <div class="form-row">
              <div v-if="!isCompact(sub)" class="form-group">
                <label>続柄</label>
                <paren-input v-model="sub.role" placeholder="長男"></paren-input>
              </div>
            </div>
            <div v-if="!isCompact(sub)" class="form-group">
              <label>出生</label>
              <era-date v-model="sub.birth" kind="birth" :not-after="sub.death"></era-date>
            </div>
            <dead-fields v-if="deadApi" :person="sub" :judge-fn="deadApi.judge" :check-fn="deadApi.check"></dead-fields>
            <div v-if="!isCompact(sub)" class="form-group">
              <label>住所（任意）</label>
              <address-input v-model="sub.addr" tip="addr"></address-input>
            </div>
            <div v-if="isCompact(sub)" class="reg-note">この方は被代襲者のため、法定相続情報一覧図には死亡年月日だけが表示されます。氏名と死亡年月日だけを入力すれば足ります。</div>
            <div v-if="showIchiranzu && !isCompact(sub)" class="checkbox-group">
              <input type="checkbox" v-model="sub.isApplicant">
              <label>申出人</label>
            </div>
            <div v-if="toggleCaseFn && (!deadApi || deadApi.entered(sub))" class="case-link-row"><label class="chk case-link-check"><input type="checkbox" :checked="!!(caseLinkedFn && caseLinkedFn(sub))" @change="toggleCaseFn(sub, $event)"><span>この方を被相続人とする手続も作る</span></label></div>
            <div v-if="showIchiranzu && !isCompact(sub) && (!creatorPerson || creatorPerson.id === sub.id)" class="checkbox-group">
              <input type="checkbox" :checked="sub.isCreator" @change="onCreatorChange(sub)">
              <label>作成者</label>
            </div>
            <substitute-editor
              v-if="(allowRecursive || (deathKindFn && deathKindFn(sub) === 'after')) && sub.substitutes && (!deadApi || deadApi.wanted(sub))"
              :substitutes="sub.substitutes"
              :parent-obj="sub"
              :is-expanded-fn="isExpandedFn"
              :toggle-fn="toggleFn"
              :add-fn="addFn"
              :remove-fn="removeFn"
              :toggle-creator-fn="toggleCreatorFn"
              :is-successor-fn="isSuccessorFn"
              :set-successor-fn="setSuccessorFn"
              :pattern-name="patternName"
              :show-ichiranzu="showIchiranzu"
              :creator-person="creatorPerson"
              :case-linked-fn="caseLinkedFn"
              :toggle-case-fn="toggleCaseFn"
              :death-kind-fn="deathKindFn"
              :compact-dead-fn="compactDeadFn"
              :dead-api="deadApi"
              :allow-recursive="true"
              :title="deathKindFn && deathKindFn(sub) === 'after' ? 'この方の相続人（数次相続）' : '再代襲相続人'"
            ></substitute-editor>

            <button v-if="(allowRecursive || (deathKindFn && deathKindFn(sub) === 'after')) && (!deadApi || deadApi.wanted(sub))" class="btn btn-outline btn-sm" style="margin-top: 6px;" @click.stop="addFn(sub)">
              {{ deathKindFn && deathKindFn(sub) === 'after' ? '＋ この方の相続人を追加（数次相続）' : '＋ さらに代襲相続人を追加' }}
            </button>
          </div>
        </div>
      </div>
    `
  };
})();
