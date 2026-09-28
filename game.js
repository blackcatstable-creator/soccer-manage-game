/* WORLD PYRAMID ELEVEN - MVP
   最小コアループ: 試合(自動シミュレーション) → 資金 → 施設投資/移籍 → 選手成長 → 昇格
   トップチームは企画書どおりの10段階リーグ。多層チーム(2軍/ユース/提携クラブ)のうち
   提携クラブは将来拡張のため本MVPでは未実装。
*/

// ---------- マスタデータ ----------

const TEAM_COUNT = 20; // 1リーグの所属クラブ数(自クラブ含む)。ホーム&アウェーで (TEAM_COUNT-1)*2 = 38試合。

// 選手能力・チーム戦力の理論上限。「戦力は最大1000まで」という前提に合わせ、
// 99ではなく1000を天井にしておく(選手生成時の初期値そのものは変えていない)。
const ABILITY_CAP = 1000;

const TIER_META = [
  { name: '地域アマチュアリーグ', promote: 3, relegate: 0 },
  { name: '市民リーグ', promote: 3, relegate: 3 },
  { name: '地方2部リーグ', promote: 3, relegate: 3 },
  { name: '地方1部リーグ', promote: 3, relegate: 3 },
  { name: '国内3部（ナショナルC）', promote: 3, relegate: 3 },
  { name: '国内2部（ナショナルB）', promote: 3, relegate: 3 },
  { name: '国内1部（ナショナルA）', promote: 3, relegate: 3 },
  { name: '大陸チャレンジリーグ', promote: 3, relegate: 3 },
  { name: '大陸プレミアリーグ', promote: 3, relegate: 3 },
  { name: 'ワールドスーパーリーグ', promote: 0, relegate: 3 },
];

// ティアごとの目安総合力(baseline)は、初期値15から「1段階上のリーグへ接続する上昇幅」を
// 積み上げて算出する。buildAiStrengths()は baseline±halfWidth の帯域に19クラブ
// (TEAM_COUNT-1)を均等割りするため、「下位リーグの理論上の2位(帯域の上から2番目)」の位置が
// 「上位リーグの理論上の下から2位(帯域の下から2番目)」にちょうど一致するよう上昇幅を逆算している。
// これにより、リーグが上がるたびに「これまでの上位陣」がそのまま「新リーグの下位陣」として
// 自然に接続される。
//
// 帯域の半幅(=同じリーグ内でのクラブ間の戦力差)はティアごとに変える: 下位リーグほど
// 狭く(拮抗した試合になりやすく、自クラブの成長がそのまま順位変動に直結しやすくなる)、
// 上位に上がるほど広く(実在のプロリーグ同様、大クラブと昇格したばかりのクラブとの差が
// はっきり出る)ようにグラデーションさせる。最下層(地域アマチュアリーグ)は半幅20、
// 最上位(ワールドスーパーリーグ)は半幅92とし、旧仕様(全ティア一律58)と同じく
// 「最上位ティアの帯域上限でちょうど戦力上限1000に達する」性質を保っている
// (下位を狭めたぶん、上位をより広げないと最上位の上限が1000未満で頭打ちになってしまうため)。
const AI_BAND_HALF_WIDTH = 58; // 帯域幅を明示せず呼び出す箇所(提携クラブ候補プールなど)向けの既定値
const AI_BAND_HALF_WIDTH_MIN = 20; // 最下位ティア(地域アマチュアリーグ)の半幅
const AI_BAND_HALF_WIDTH_MAX = 92; // 最上位ティア(ワールドスーパーリーグ)の半幅
const TIER_HALF_WIDTH = TIER_META.map((_, i) =>
  Math.round(AI_BAND_HALF_WIDTH_MIN + (AI_BAND_HALF_WIDTH_MAX - AI_BAND_HALF_WIDTH_MIN) * i / (TIER_META.length - 1))
);
// 帯域の「上から2番目/下から2番目」が半幅の何倍の位置にあるか(TEAM_COUNT=20クラブ前提の係数)。
// 半幅が一定なら旧TIER_BASELINE_STEPと同じ値になる。
const AI_BAND_CONNECT_COEF = (TEAM_COUNT - 4) / (TEAM_COUNT - 2);

// halfWidths: 各ティアの半幅の配列(TIER_HALF_WIDTHなど)。隣接ティアの半幅が異なっていても
// 「下位リーグの上から2番目」=「上位リーグの下から2番目」の接続が保たれるよう、都度
// 両ティアの半幅から上昇幅を計算する。
function buildBaselineLadder(initial, halfWidths) {
  const arr = [initial];
  for (let i = 1; i < halfWidths.length; i++) {
    const step = AI_BAND_CONNECT_COEF * (halfWidths[i - 1] + halfWidths[i]);
    arr.push(Math.round(arr[i - 1] + step));
  }
  return arr;
}

const TIER_BASELINE = buildBaselineLadder(15, TIER_HALF_WIDTH); // そのティアの「平均的なチーム総合力」の目安

// ECON: ティアごとの経済スケール。sponsorWeekly・人件費・賞金・移籍相場・施設費など
// 金銭に関わる値はすべてここから導出することで、「昇格直後は少し苦しく、定着・評判が上がると
// 黒字化する」という難易度カーブを全ティアで一貫させている(単純に絶対値だけ上げるとティアごとに
// 楽/苦のムラができるため)。
const ECON = [1, 2, 3, 6, 10, 18, 30, 51, 88, 150];
// 「何もしなくても資金は少しずつ増える(週平均+収支)が、施設を上げたり高額な選手を
// 獲得したりすると人件費・維持費が伸びて簡単に赤字転落しうる」という難易度カーブを狙って
// 逆算した値(econ=1・初期スカッド・初期所持施設のみの状態でMonte Carloシミュレーションし、
// 週平均収支が小幅な黒字になるよう調整している)。
const BASE_SPONSOR = 68; // econ=1のときの週間スポンサー基礎額(万円)。序盤の収入に余裕を持たせるため引き上げ済み
const AVG_WAGE_PER_PLAYER = 1.0; // baseline総合力の選手1人あたり週給(万円, econ=1のとき)

// 施設維持費は「レベル×定数」の線形ではなく「定数×レベル^EXP」の凸関数にする。
// レベル1(=最初から持っている必須施設)はごく軽い負担に抑えつつ、レベルを上げるほど
// 1段階あたりの維持費増分が大きくなるため、「施設をどんどん強化する」ほど収支管理の
// シビアさが増していく(=無投資なら黒字が積み上がり、投資するほど選手給与とのバランスが
// 問われる)というカーブになる。
const FACILITY_MAINT_EXP = 1.3;
const FACILITY_MAINT_MULT = { flat: 2.8, ground: 1.4, stadium: 2.0, shop: 1.6 };

// 1位〜TEAM_COUNT位の賞金比率(econ=1のとき)。上位ほど手厚く、指数的に減衰させる。
// (普段の週間収入に対して賞金が見劣りしすぎないよう、基礎額を旧来の6倍に引き上げ済み。
// シーズン優勝クラスの結果を残せば、その賞金だけで補強2〜3回分をまかなえる水準にするための調整)
const PRIZE_SHAPE = Array.from({ length: TEAM_COUNT }, (_, i) => Math.round(1800 * Math.pow(0.88, i)));

// 順位ごとの評判増減。1位が最も評判が伸び、最下位が最も評判を落とす。この変動は「同じティア内
// での好不調」を示す小さな上下動にとどめる(評判の伸びの主役はreputationCapForTier()による
// ティア連動の上限とendSeason()の昇格ボーナス)。
function repDeltaForPosition(position, total) {
  return Math.round(15 - ((position - 1) / (total - 1)) * 27);
}

// 評判値は「今のティアで到達しうる上限」を超えて伸びない(昇格して初めて次の上限が解放される)。
// tier0(最下層)は100、tier9(最上位)で1000に達するよう、ティア+1に比例させる。これが無いと、
// 昇格できなくても好成績・スポンサー契約・カップ戦を積み重ねるだけで評判がどんどん上限に
// 張り付いてしまい、「下のリーグなのに評判値だけ極端に高い」状態になってしまう。
function reputationCapForTier(tierIdx) {
  return (tierIdx + 1) * 100;
}

// クラブの魅力(評判)に選手の質(quality: overallや潜在能力から算出)が見合っていないほど、
// 他クラブへ引き抜かれる(離脱する)リスクが高くなる。multiplierで場面ごとの強さを調整する
// (年代が上がる節目は1.0、通常のシーズン経過は0.15など、節目の方が高リスクになるよう呼び分ける)。
function departureRisk(quality, reputation, multiplier) {
  const gap = quality - reputation;
  if (gap <= 10) return 0.01 * multiplier; // 評判が質に見合っていればごく僅かな基礎リスクのみ
  return clamp(0.01 + (gap - 10) * 0.006, 0.01, 0.65) * multiplier;
}

const TIERS = TIER_META.map((meta, i) => ({
  ...meta,
  econ: ECON[i],
  baseline: TIER_BASELINE[i],
  sponsorWeekly: Math.round(BASE_SPONSOR * ECON[i]),
  prizePool: PRIZE_SHAPE.map(v => Math.round(v * ECON[i])),
}));

// 移籍価格・施設アップグレード費用は sqrt(econ) で緩やかにスケール
// (週間の人件費ほど急激に上げると、上位ティアで一切選手補強や施設投資ができなくなるため)
const TIER_PRICE_MULT = ECON.map(e => +(0.4 * Math.sqrt(e)).toFixed(2));

// トップチーム直属の施設(スカウト)+ 下部組織に紐づく施設(所持が前提条件のもの)。
// 「training」「medical」は年代別「練習場」バンドル(GROUND_FACILITY_META)に統合したため廃止。
// スタジアム(メインスタンド・サブスタンド・VIPルーム・ビール・食事)は詳細な複数施設バンドル
// (STADIUM_FACILITY_META)に分離したため、ここには含めない。
const FACILITY_META = {
  scout:            { label: 'トップチームスカウト網', desc: '移籍市場に出る候補の人数・質が上がる。リーグ昇格ごとに上限が5段階分広がる', base: 150 },
  scoutYouth:       { label: 'ユーススカウト', desc: 'ユース世代の新加入選手の質が上がる', base: 130, requires: 'youth' },
  scoutJuniorYouth: { label: 'ジュニアユーススカウト', desc: 'ジュニアユース世代の新加入選手の質が上がる', base: 110, requires: 'juniorYouth' },
  scoutU12:         { label: 'U-12スカウト', desc: 'U-12世代の新規発掘人数・質が上がる', base: 100, requires: 'u12' },
  youthStadium:     { label: 'ユース以下スタジアム', desc: 'ユース・ジュニアユース・U-12の試合会場をまとめて管理する簡易スタジアム。観客動員によるわずかな興行収入が入る', base: 180, requires: 'anyYouth' },
  shopRegional:     { label: '地方展開ショップ', desc: '本拠地以外の主要都市にアンテナショップを出店する。ホーム/アウェーを問わず、評判が高いほど毎週の売上が伸びる', base: 170 },
  shopOnline:       { label: 'ECサイト(通販)', desc: 'オンライン通販でグッズを全国発送する。低コストで序盤から着手でき、評判上昇とともに緩やかに売上が伸びる', base: 90 },
  shopOverseas:     { label: '海外ショップ展開', desc: '海外移籍・レンタルで活躍するOB選手の知名度を追い風に海外店舗を展開する。大陸チャレンジリーグ(L8)到達で解放', base: 260, requires: 'continental' },
  shopLicense:      { label: 'マスコット・IPライセンス', desc: 'クラブマスコットやエンブレムの商品化権を他社に供与しロイヤリティを得る。維持費は低いが、ワールドスーパーリーグ(L10)到達で初めて解放される', base: 300, requires: 'worldStage' },
};
const FACILITY_BASE_MAX = 5;
// スカウト網だけは「所属リーグ級ごとに5段階」で上限が伸びる特別な施設にする
// (例: 地域アマチュア=Lv1-5, 市民リーグ=Lv1-10, ... )。ティアが上がるほど、より細かく
// 長くレベルアップし続けられるようにして、移籍市場の質を徐々に底上げしていく体験にする。
// さらにクラブランクの段階(0〜9)ぶんも上限に加算し、同じティア内でもクラブの総合力が
// 高いほど施設をさらに伸ばせるようにする(クラブランクを施設上限に紐づける設計)。
const SCOUT_LEVELS_PER_TIER = 5;
function scoutMaxLevel(tierIdx) { return (tierIdx + 1) * SCOUT_LEVELS_PER_TIER + clubRankStage(); }
function facilityMaxLevel(key) {
  return key === 'scout' ? scoutMaxLevel(state.club.tier) : FACILITY_BASE_MAX + clubRankStage();
}

// ---------- ユース組織(下部組織チームの所持) ----------
// 「そもそも所持するかどうか」の一段階のみの施設。前提チームを所持していないと新設できない。
const YOUTH_TEAM_META = {
  reserve:            { label: '2軍', order: 1, prereq: null },
  youth:              { label: 'ユース', order: 2, prereq: null },
  youthReserve:       { label: 'ユース2軍', order: 3, prereq: 'youth' },
  juniorYouth:        { label: 'ジュニアユース', order: 4, prereq: null },
  juniorYouthReserve: { label: 'ジュニアユース2軍', order: 5, prereq: 'juniorYouth' },
  u12_1:              { label: 'U-12 1チーム目', order: 6, prereq: null },
  u12_2:              { label: 'U-12 2チーム目', order: 7, prereq: 'u12_1' },
  u12_3:              { label: 'U-12 3チーム目', order: 8, prereq: 'u12_2' },
  u12_4:              { label: 'U-12 4チーム目', order: 9, prereq: 'u12_3' },
  u12_5:              { label: 'U-12 5チーム目', order: 10, prereq: 'u12_4' },
  // 3〜5軍のorderはジュニアユース(order:4)を基準に、3軍がジュニアユースとほぼ同額になるよう
  // 設定した値(旧11/12/13は高すぎたため引き下げ。旧値と同じ相対的な刻み幅は維持している)。
  reserve3:           { label: '3軍', order: 4,   prereq: 'reserve' },
  reserve4:           { label: '4軍', order: 4.4, prereq: 'reserve3' },
  reserve5:           { label: '5軍', order: 4.8, prereq: 'reserve4' },
};
const YOUTH_TEAM_ORDER = Object.keys(YOUTH_TEAM_META);
// トップチーム傘下の予備軍(2軍〜5軍)。同じ19歳以上のreserveプールを能力順に
// 26人ずつ切り出し、階層(2軍=上位26人・3軍=次の26人…)として扱う。
const RESERVE_LEVEL_KEYS = ['reserve', 'reserve3', 'reserve4', 'reserve5'];
// 下部組織リーグの「実際のクラブ名」に使う接尾辞(YOUTH_TEAM_META.labelは施設タブ等の
// 組織ラベルとして維持し、こちらはクラブ名生成専用に分けて持つ)。自クラブ・AI対戦相手の
// 双方に同じ接尾辞を付ける(startAcademyLeagueSeason参照)。
const TEAM_NAME_SUFFIX = {
  reserve: 'セカンド', reserve3: 'サード', reserve4: 'フォース', reserve5: 'フィフス',
  youth: 'ユース', youthReserve: 'ユースセカンド',
  juniorYouth: 'ジュニアユース', juniorYouthReserve: 'ジュニアユースセカンド',
  u12_1: 'U-12 1', u12_2: 'U-12 2', u12_3: 'U-12 3', u12_4: 'U-12 4', u12_5: 'U-12 5',
};
// 国内1部(7段階目, econ=30, tierMult≈5.48)にようやく届くくらいの資金感を基準値にする。
// (地域アマチュア/地方1部の序盤ではまだ手が出しづらい金額感にするため、旧来値より大幅に引き上げた)
const YOUTH_TEAM_BASE_COST = 1800;

// 下部組織の「系統」(2軍系 / ユース / ジュニアユース / U-12)。柱2(コスト逓減)の
// 「初回チーム割引」の判定に使う。categoryOfTeamKey()はreserve3/4/5を個別に返すため、
// 系統でまとめ直したこちらを使う。
function youthBranchOfKey(key) {
  if (RESERVE_LEVEL_KEYS.includes(key)) return 'reserve';
  if (key === 'youth' || key === 'youthReserve') return 'youth';
  if (key === 'juniorYouth' || key === 'juniorYouthReserve') return 'juniorYouth';
  return 'u12';
}
// その系統でまだ1チームも所持していなければ true(＝これから建てるのが系統初のチーム)。
function isFirstYouthUnitOfBranch(key) {
  const branch = youthBranchOfKey(key);
  return !YOUTH_TEAM_ORDER.some(k => state.club.youthTeams[k] && youthBranchOfKey(k) === branch);
}
// 企画書12.3(柱2): 各系統の最初の1チームだけ大幅割引(×0.4)。「まず触らせる」ための入口。
const FIRST_YOUTH_UNIT_DISCOUNT = 0.4;

function youthTeamCost(key) {
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  const base = YOUTH_TEAM_BASE_COST * Math.pow(YOUTH_TEAM_META[key].order, 1.3) * tierMult;
  const discount = isFirstYouthUnitOfBranch(key) ? FIRST_YOUTH_UNIT_DISCOUNT : 1;
  return Math.round(base * discount);
}

function u12OwnedCount() {
  return ['u12_1', 'u12_2', 'u12_3', 'u12_4', 'u12_5'].filter(k => state.club.youthTeams[k]).length;
}

// そのアカデミーカテゴリの「今のティア」。u12は複数チーム(u12_1〜5)を持ちうるため、
// 所持チームの中で最も進んでいるティアを代表値として使う(まだどのリーグにも
// 参戦していないシーズン開始直後はティア0扱い)。
function academyCategoryTierIdx(cat) {
  if (cat === 'u12') {
    const tiers = ['u12_1', 'u12_2', 'u12_3', 'u12_4', 'u12_5']
      .filter(k => state.club.youthTeams[k])
      .map(k => (state.club.academyLeagues[k] ? state.club.academyLeagues[k].tier : 0));
    return tiers.length ? Math.max(...tiers) : 0;
  }
  const league = state.club.academyLeagues[cat];
  return league ? league.tier : 0;
}

function reserveLevelsOwnedCount() {
  return RESERVE_LEVEL_KEYS.filter(k => state.club.youthTeams[k]).length;
}

// requires: null(常時所持=トップチーム) | 'reserve' | 'youth' | 'juniorYouth' | 'u12'(1チーム以上所持で可)
// | 'anyYouth'(ユース/ジュニアユース/U-12のいずれか1つ以上所持で可。ユース以下スタジアムの解放条件)
// | 'reserveLower'(3軍/4軍/5軍のいずれか1つ以上所持で可。3〜5軍共用スタジアムの解放条件。
//   練習場は3軍/4軍/5軍それぞれ個別のチーム所持キーで解放される)
// 'continental'/'worldStage'はクラブランク(clubRankStage)ではなくリーグ段階(state.club.tier)で
// 判定する。clubRankStage()はclubRankFacilityScore()を経由してこの関数を呼び返すため、
// ここでclubRankStage()に依存すると循環参照になってしまう(1014行目付近の注記と同じ理由)。
function isCategoryOwned(cat) {
  if (!cat) return true;
  if (cat === 'u12') return u12OwnedCount() > 0;
  if (cat === 'anyYouth') return !!state.club.youthTeams.youth || !!state.club.youthTeams.juniorYouth || u12OwnedCount() > 0;
  if (cat === 'reserveLower') return ['reserve3', 'reserve4', 'reserve5'].some(k => state.club.youthTeams[k]);
  if (cat === 'continental') return state.club.tier >= 7;
  if (cat === 'worldStage') return state.club.tier >= 9;
  return !!state.club.youthTeams[cat];
}

function categoryOfTeamKey(key) {
  if (key === 'reserve' || key === 'reserve3' || key === 'reserve4' || key === 'reserve5') return key;
  if (key === 'youth' || key === 'youthReserve') return 'youth';
  if (key === 'juniorYouth' || key === 'juniorYouthReserve') return 'juniorYouth';
  return 'u12';
}

// ---------- コーチ・監督 ----------
// 各チーム(トップチーム筆頭に、所持している下部組織チームそれぞれ)は8枠のスタッフを持つ:
// 監督1人(全体に効く) + 個別能力値コーチ5人(オフェンス/ディフェンス/GK/フィジカル/スピード、
// 能力値がそのまま該当パラメータの成長への効果になる) + アシスタントコーチ2人(監督より
// 少し弱い係数で全体に効く。60歳定年で監督・コーチが抜けた際の後任候補として"囲っておく"
// 意味合いも持つ)。監督・コーチは60歳定年制で、定年を迎えると能力の低い若手コーチが
// 自動的に後任として就任する(枠が空白のままになることはない)。
// 采配(どの枠に誰を置くか)はオーナーがいつでも自由に変更できる(コーチタブでの入れ替え)。
const COACH_ROLE_META = {
  manager:    { label: '監督' },
  off:        { label: 'オフェンスコーチ' },
  def:        { label: 'ディフェンスコーチ' },
  gk:         { label: 'GKコーチ' },
  phy:        { label: 'フィジカルコーチ' },
  spd:        { label: 'スピードコーチ' },
  assistant1: { label: 'アシスタントコーチ1' },
  assistant2: { label: 'アシスタントコーチ2' },
};
const COACH_ROLE_ORDER = Object.keys(COACH_ROLE_META);
const COACH_ATTR_ROLES = ['off', 'def', 'gk', 'phy', 'spd'];

const COACH_TEAM_META = { top: { label: 'トップチーム' } };
YOUTH_TEAM_ORDER.forEach(key => { COACH_TEAM_META[key] = { label: YOUTH_TEAM_META[key].label }; });
const COACH_TEAM_ORDER = ['top', ...YOUTH_TEAM_ORDER];

function isCoachTeamOwned(teamKey) {
  return teamKey === 'top' ? true : !!state.club.youthTeams[teamKey];
}

function genCoachName() { return `${choice(FIRST_NAMES)}・${choice(LAST_NAMES)}`; }

function createCoach(minAbility, maxAbility, minAge, maxAge) {
  return { id: uid(), name: genCoachName(), age: randInt(minAge, maxAge), ability: randInt(minAbility, maxAbility) };
}

// 初期配置・新規チーム発足時は、空白にせず能力の低め(15〜35)なコーチを適当に配置しておく。
function createInitialCoachSet() {
  const set = {};
  COACH_ROLE_ORDER.forEach(role => { set[role] = createCoach(15, 35, 32, 58); });
  return set;
}

function ensureCoachSet(teamKey) {
  if (!state.club.coaches[teamKey]) state.club.coaches[teamKey] = createInitialCoachSet();
}

function coachSet(teamKey) { return state.club.coaches[teamKey]; }

// 監督の能力値は成長・戦術面で全体に効く(係数20)。アシスタント2人の平均は、監督より弱い
// 係数30で全体に効く("少しだけ利く")。
function coachOverallGrowthBonus(teamKey) {
  const set = coachSet(teamKey);
  if (!set) return 0;
  const mgr = set.manager.ability / 20;
  const asst = ((set.assistant1.ability + set.assistant2.ability) / 2) / 30;
  return mgr + asst;
}
// 個別コーチ(off/def/gk/phy/spd)の能力値は、そのままそのパラメータの成長ボーナスになる。
function coachAttrGrowthBonus(teamKey, attr) {
  const set = coachSet(teamKey);
  if (!set) return 0;
  return set[attr].ability / 20;
}
// 監督・アシスタントの能力は試合の戦術面にも小さく寄与する(チーム総合力への上乗せ)。
function coachMatchBonus(teamKey) {
  const set = coachSet(teamKey);
  if (!set) return 0;
  const mgr = set.manager.ability;
  const asst = (set.assistant1.ability + set.assistant2.ability) / 2;
  return (mgr + asst * 0.5) / 30;
}

// 2軍枠(ユース2軍/ジュニアユース2軍)やU-12の複数チームは同じ育成プールを共有しているため、
// 該当カテゴリで所持している全チームのコーチ陣の平均を育成プールの成長ボーナスとして使う。
function coachTeamKeysForCategory(cat) {
  return YOUTH_TEAM_ORDER.filter(k => categoryOfTeamKey(k) === cat && state.club.youthTeams[k]);
}
function avgCoachBonusForCategory(cat, fn) {
  const keys = coachTeamKeysForCategory(cat);
  if (!keys.length) return 0;
  return keys.reduce((s, k) => s + fn(k), 0) / keys.length;
}

// シーズン終了時に呼び出す: 全コーチ・監督を1歳加齢し、60歳に達した者を定年退任させる。
// 退任した枠には能力の低い若手コーチが自動的に就任する(空白にはしない)。
function ageCoachesAndRetire() {
  const retiredNames = [];
  COACH_TEAM_ORDER.forEach(teamKey => {
    const set = state.club.coaches[teamKey];
    if (!set) return;
    COACH_ROLE_ORDER.forEach(role => {
      const c = set[role];
      c.age += 1;
      if (c.age >= 60) {
        retiredNames.push(`${COACH_TEAM_META[teamKey].label}${COACH_ROLE_META[role].label}(${c.name})`);
        set[role] = createCoach(10, 28, 28, 45);
      }
    });
  });
  if (retiredNames.length) {
    addLog(`${retiredNames.length}名の監督・コーチが60歳定年で退任しました: ${retiredNames.join('、')}。後任には若手コーチが自動的に就任しています。必要に応じて「コーチ」タブで配置転換してください。`, 'gold');
  }
}

// ---------- 年代別「練習場」バンドル ----------
// 医療施設もこのバンドルの1項目として、年代(トップ/2軍/3軍/4軍/5軍/ユース/ジュニアユース/U-12)
// ごとに持つ。3軍/4軍/5軍はそれぞれ個別のチーム(所持キー)に紐づく個別の練習場を持つ
// (スタジアムは引き続き3〜5軍で共用)。
const GROUND_CATEGORIES = {
  top:         { label: 'トップチーム' },
  reserve:     { label: '2軍' },
  reserve3:    { label: '3軍' },
  reserve4:    { label: '4軍' },
  reserve5:    { label: '5軍' },
  youth:       { label: 'ユース' },
  juniorYouth: { label: 'ジュニアユース' },
  u12:         { label: 'U-12' },
};
const GROUND_CATEGORY_ORDER = ['top', 'reserve', 'reserve3', 'reserve4', 'reserve5', 'youth', 'juniorYouth', 'u12'];
const GROUND_FACILITY_META = {
  pitch:    { label: '練習場', desc: '選手の成長速度が上がる', base: 120 },
  turf:     { label: '芝', desc: '怪我や不調による能力停滞・低下を防ぐ', base: 90 },
  lighting: { label: '照明', desc: '新加入選手や成長期の選手の潜在能力の伸びしろが上がる', base: 90 },
  pool:     { label: 'プール', desc: 'コンディション回復を早め、成長・能力低下を助ける', base: 100 },
  medical:  { label: '医療施設', desc: 'ベテラン選手の能力低下を抑える', base: 140 },
};
const GROUND_FACILITY_BASE_MAX = 5;
// 練習場バンドルのレベル上限もクラブランクの段階(0〜9)ぶん伸びる。
function groundFacilityMaxLevel() { return GROUND_FACILITY_BASE_MAX + clubRankStage(); }

function zeroGroundBundle() {
  return { pitch: 0, turf: 0, lighting: 0, pool: 0, medical: 0 };
}
function fullGroundBundle() {
  return { pitch: 1, turf: 1, lighting: 1, pool: 1, medical: 1 };
}

function initGroundsForCategory(cat) {
  const bundle = state.club.facilities.grounds[cat];
  if (Object.values(bundle).every(v => v === 0)) {
    Object.keys(bundle).forEach(k => { bundle[k] = 1; });
  }
}

function groundsCost(category, sub) {
  const lv = state.club.facilities.grounds[category][sub];
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  return Math.round(GROUND_FACILITY_META[sub].base * Math.pow(lv + 1, 1.5) * tierMult);
}

// トップチーム〜5軍(いずれも「アダルト」扱いの階層)は基礎26人、ユース/ジュニアユースは
// 基礎18人を上限の目安にする(いずれも充足しなくてもよい、あくまで上限)。
const ADULT_SQUAD_BASE_CAP = 26;
const YOUTH_CATEGORY_BASE_CAP = 18;

function squadCap() {
  return ADULT_SQUAD_BASE_CAP;
}

// ---------- スタジアム(メインスタンド/サブスタンド/VIPルーム/ビール/食事) ----------
// トップチームと2軍(2軍スタジアムまで)は、それぞれ5種の施設からなる詳細なバンドルを持つ。
// ユース・ジュニアユース・U-12は年代ごとに分けず、1つの簡易施設(FACILITY_META.youthStadium)
// に集約する。全ての項目が何らかの形で収入に結びつく設計にしている。
const STADIUM_FACILITY_META = {
  mainStand: { label: 'メインスタンド', desc: '収容人数の中心。チケット収入と観客動員数(クラブの格にも影響)を押し上げる', base: 300 },
  subStand:  { label: 'サブスタンド', desc: '収容人数を追加し、チケット収入と観客動員数をさらに底上げする', base: 170 },
  vipRoom:   { label: 'VIPルーム', desc: '法人・富裕層向けの特別観戦席。試合ごとに高額な追加収入を生む', base: 260 },
  beer:      { label: 'ビール販売', desc: '観客動員数に応じたドリンク収入を増やす', base: 100 },
  food:      { label: '飲食販売', desc: '観客動員数に応じたフード収入を増やす', base: 100 },
};
const STADIUM_FACILITY_ORDER = ['mainStand', 'subStand', 'vipRoom', 'beer', 'food'];
const STADIUM_FACILITY_BASE_MAX = 8;
// スタジアムのレベル上限もクラブランクの段階(0〜9)ぶん伸びる。
function stadiumFacilityMaxLevel() { return STADIUM_FACILITY_BASE_MAX + clubRankStage(); }
const STADIUM_CATEGORY_LABEL = { top: 'メインスタジアム', reserve: '2軍スタジアム', reserveLower: '3軍・4軍・5軍スタジアム' };

function zeroStadiumBundle() {
  return { mainStand: 0, subStand: 0, vipRoom: 0, beer: 0, food: 0 };
}

function stadiumCost(category, sub) {
  const lv = state.club.facilities.stadiums[category][sub];
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  return Math.round(STADIUM_FACILITY_META[sub].base * Math.pow(lv + 1, 1.55) * tierMult);
}

// 収容人数はメインスタンド・サブスタンドのレベルのみで決まる(VIP/飲食は収容ではなく客単価側)。
const STADIUM_CAPACITY_BASE = { top: 800, reserve: 300, reserveLower: 150 };
const STADIUM_CAPACITY_PER_LEVEL = {
  top:     { mainStand: 2000, subStand: 900 },
  reserve: { mainStand: 700, subStand: 300 },
  reserveLower: { mainStand: 400, subStand: 150 },
};
function stadiumCapacity(category) {
  const s = state.club.facilities.stadiums[category];
  const per = STADIUM_CAPACITY_PER_LEVEL[category];
  return STADIUM_CAPACITY_BASE[category] + s.mainStand * per.mainStand + s.subStand * per.subStand;
}

// 評判(0〜1000)に応じた収容人数に対する観客動員率(0.5〜1.0)。
function attendanceFactor(reputation) {
  return clamp(0.5 + reputation / 2000, 0.5, 1.0);
}

// 施設を新設(Lv0→1)した際の伸びを、その後の1段階ぶんの伸びより大きくするための補正。
// 所持している(Lv1以上の)施設には常に+1段ぶんのボーナスレベルを乗せることで、
// 新設直後の収入増を大きくしつつ、以降の1段階あたりの増分は据え置く。
function bonusedLevel(lv) { return lv > 0 ? lv + 1 : 0; }

// ホームゲームで発生するスタジアム収入(5項目合算)。observedAttendanceは表示・記録用。
function stadiumHomeIncome(category, econSqrt) {
  const s = state.club.facilities.stadiums[category];
  const af = attendanceFactor(state.club.reputation);
  const attendance = Math.round(stadiumCapacity(category) * af);
  // 大会賞金を旧来の3倍に引き上げたぶんとのバランスを取るため、スタジアム収入係数は
  // 全項目を約1割引き下げている(普段の収入だけで大会賞金並みに稼げてしまわないようにするため)。
  const mainStandIncome = Math.round(bonusedLevel(s.mainStand) * 50 * af * econSqrt);
  const subStandIncome = Math.round(bonusedLevel(s.subStand) * 27 * af * econSqrt);
  const vipIncome = Math.round(bonusedLevel(s.vipRoom) * 63 * (0.6 + af * 0.4) * econSqrt);
  const beerIncome = Math.round(bonusedLevel(s.beer) * 20 * af * econSqrt);
  const foodIncome = Math.round(bonusedLevel(s.food) * 20 * af * econSqrt);
  return { attendance, total: mainStandIncome + subStandIncome + vipIncome + beerIncome + foodIncome };
}

// ---------- 常設ショップ(スタジアム型/練習場型) ----------
// スタジアム収入(stadiumHomeIncome)と違い、ホームゲームの有無に関係なく毎週収入が発生する
// 「ショップ施設」のうち、既存の施設カテゴリ(スタジアム/練習場)に紐づく2種類。
// 単一レベルのシンプルな施設で、所持している当該カテゴリのチームがあれば投資できる。
const SHOP_LOCATION_META = { desc: 'スタジアム/練習場の敷地内に併設する物販店。試合の有無・ホーム/アウェーを問わず、評判に応じて毎週収入が入る' };
const SHOP_LOCATION_BASE_MAX = FACILITY_BASE_MAX;
function shopLocationMaxLevel() { return SHOP_LOCATION_BASE_MAX + clubRankStage(); }

function zeroShopStadiumBundle() { return { top: 0, reserve: 0, reserveLower: 0 }; }
function zeroShopGroundBundle() {
  return { top: 0, reserve: 0, reserve3: 0, reserve4: 0, reserve5: 0, youth: 0, juniorYouth: 0, u12: 0 };
}

function shopStadiumCost(category) {
  const lv = state.club.facilities.shopStadium[category];
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  return Math.round(140 * Math.pow(lv + 1, 1.5) * tierMult);
}
function shopGroundCost(category) {
  const lv = state.club.facilities.shopGround[category];
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  return Math.round(110 * Math.pow(lv + 1, 1.5) * tierMult);
}

// ホーム/アウェーを問わず毎週加算されるショップ収入の合算(常設×スタジアム/練習場 +
// 地方展開/EC/海外/ライセンスのフラット施設)。評判(rep)に応じて緩やかに伸びる。
function shopWeeklyIncome(econSqrt) {
  const f = state.club.facilities;
  const rep = state.club.reputation;
  const repFactor = 0.4 + rep / 2500;
  let total = 0;
  ['top', 'reserve', 'reserveLower'].forEach(cat => {
    if (cat !== 'top' && !isCategoryOwned(cat)) return;
    total += bonusedLevel(f.shopStadium[cat]) * 16 * repFactor;
  });
  GROUND_CATEGORY_ORDER.forEach(cat => {
    if (cat !== 'top' && !isCategoryOwned(cat)) return;
    total += bonusedLevel(f.shopGround[cat]) * 11 * repFactor;
  });
  total += bonusedLevel(f.shopRegional) * 26 * repFactor;
  total += bonusedLevel(f.shopOnline) * 15 * repFactor;
  if (isCategoryOwned('continental')) total += bonusedLevel(f.shopOverseas) * 42 * repFactor;
  if (isCategoryOwned('worldStage')) total += bonusedLevel(f.shopLicense) * 55 * repFactor;
  SHOP_PRODUCT_KEYS.forEach(key => {
    total += bonusedLevel(f.shopProducts[key]) * 14 * shopProductRepFactor(SHOP_PRODUCT_META[key].repSensitivity);
  });
  return Math.round(total * econSqrt);
}

// ---------- 取り扱い商品(ユニフォーム等の商品ラインナップ) ----------
// 常設ショップ・地方展開・ECサイトなど「どこで売るか」に対し、こちらは「何を売るか」の軸。
// 商品ごとに人気(評判)への感応度(repSensitivity)を変えることで、同じ評判上昇でも
// 「レプリカユニフォームは爆発的に伸びるが、実用雑貨はほとんど変わらない」という商品特性の違いを表現する。
// rep=500を基準(係数1.0)とし、そこからの評判の上下にsensitivityを掛けて振れ幅を作る。
const SHOP_PRODUCT_META = {
  jersey: { label: 'レプリカユニフォーム', desc: '看板商品。人気(評判)の影響を最も強く受け、評判が高いほど売上が跳ね上がる一方、低迷時は落ち込みも大きい', base: 210, repSensitivity: 1.6 },
  towel:  { label: 'マフラー・タオル', desc: '定番の応援グッズ。人気にそこそこ左右される', base: 130, repSensitivity: 1.0 },
  goods:  { label: 'キーホルダー・雑貨', desc: '実用グッズ中心。人気による変動は小さく、比較的安定して売れる', base: 90, repSensitivity: 0.55 },
  snack:  { label: 'クラブ限定フード・文具', desc: '常連サポーター向けの定番品。人気にほとんど左右されず底堅く売れる', base: 65, repSensitivity: 0.25 },
};
const SHOP_PRODUCT_KEYS = Object.keys(SHOP_PRODUCT_META);
const SHOP_PRODUCT_BASE_MAX = FACILITY_BASE_MAX;
function shopProductMaxLevel() { return SHOP_PRODUCT_BASE_MAX + clubRankStage(); }

function zeroShopProductBundle() {
  const bundle = {};
  SHOP_PRODUCT_KEYS.forEach(key => { bundle[key] = 0; });
  return bundle;
}

function shopProductRepFactor(sensitivity) {
  const rep = state.club.reputation;
  return clamp(1 + ((rep - 500) / 1000) * sensitivity, 0.15, 2.2);
}

function shopProductCost(key) {
  const lv = state.club.facilities.shopProducts[key];
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  return Math.round(SHOP_PRODUCT_META[key].base * Math.pow(lv + 1, 1.5) * tierMult);
}

function upgradeShopProduct(key) {
  const bundle = state.club.facilities.shopProducts;
  const lv = bundle[key];
  if (lv >= shopProductMaxLevel()) { toast('既に最大レベルです'); return; }
  const cost = shopProductCost(key);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  bundle[key] += 1;
  addLog(`${SHOP_PRODUCT_META[key].label}が Lv.${bundle[key]} になりました。`, 'good');
  save();
  render();
}

// ---------- アカデミー(下部組織の育成パイプライン) ----------
// U-12 → ジュニアユース → ユース → 2軍(以下)と年齢で昇格していく。上位カテゴリのチームを
// 所持していないと、その年代に上がるタイミングで選手は離脱する。reserve(2〜5軍)には
// 年齢上限を設けず、19歳以降は能力次第で何歳でも在籍・トップチーム昇格のチャンスがある
// (processReserveGraduation()が毎シーズンの継続的な昇格/引き抜き判定を行う)。
const ACADEMY_BRACKETS = [
  { key: 'u12', minAge: 10, maxAge: 12 },
  { key: 'juniorYouth', minAge: 13, maxAge: 15 },
  { key: 'youth', minAge: 16, maxAge: 18 },
  { key: 'reserve', minAge: 19, maxAge: Infinity },
];

// ユース以下(U-12/ジュニアユース/ユース)の選手は潜在能力の実数値を明かさず、
// 「伸びる余地(potential - overall)」を★1〜10の粗い目安だけ見せる。2軍以上の
// カテゴリに上がった時点で初めて潜在値が確定・公開される。
const HIDDEN_POTENTIAL_CATEGORIES = ['u12', 'juniorYouth', 'youth'];
function isPotentialHidden(category) { return HIDDEN_POTENTIAL_CATEGORIES.includes(category); }
function growthRoomStars(p) {
  const gap = Math.max(0, p.potential - p.overall);
  return clamp(Math.ceil(gap / 5), 1, 10);
}
function growthRoomHtml(p) {
  const n = growthRoomStars(p);
  return `<span class="growth-stars" title="伸びしろの目安(潜在値は上のカテゴリへの昇格時に確定)">伸びしろ ${'★'.repeat(n)}${'☆'.repeat(10 - n)}</span>`;
}
function potentialOrGrowthHtml(p) {
  return isPotentialHidden(p.category) ? growthRoomHtml(p) : `潜在 ${p.potential}`;
}

function scoutLevelForCategory(cat) {
  if (cat === 'u12') return state.club.facilities.scoutU12;
  if (cat === 'juniorYouth') return state.club.facilities.scoutJuniorYouth;
  if (cat === 'youth') return state.club.facilities.scoutYouth;
  return 0;
}

// トップ(26人固定)・ユース以下(18人固定)ともに在籍上限は固定値であり、練習場バンドルの
// 施設レベルはこの上限には影響しない(成長速度・潜在能力・能力低下防止のみに効く)。
function categoryCapacity(cat) {
  if (cat === 'reserve') return ADULT_SQUAD_BASE_CAP * reserveLevelsOwnedCount();
  // U-12はチームごとに独立して18人(=ユース/ジュニアユースと同じ基礎上限)ぶんの
  // 在籍枠を持つ(所持チーム数ぶん単純倍化)。
  if (cat === 'u12') return YOUTH_CATEGORY_BASE_CAP * u12OwnedCount();
  // 「2軍」枠(ユース2軍/ジュニアユース2軍)を所持していると、reserve(2〜5軍)と同じ考え方で
  // 本体と同じ人数ぶんの階層がもう1段増える(=能力順に本体・2軍へ切り出せる実質的な
  // 別ロースターになる。詳細はtieredLevelPool参照)。
  if (cat === 'youth') return YOUTH_CATEGORY_BASE_CAP * (state.club.youthTeams.youthReserve ? 2 : 1);
  if (cat === 'juniorYouth') return YOUTH_CATEGORY_BASE_CAP * (state.club.youthTeams.juniorYouthReserve ? 2 : 1);
  return YOUTH_CATEGORY_BASE_CAP;
}

// ---------- 下部組織リーグ(年代別のリーグ戦) ----------
// トップチームと同じ「20クラブ・ホーム&アウェー総当たり」の形式で、年代ごとに専用の
// 10段階リーグを持たせる。トップチームのTIERSとは独立した、下部組織専用の10段階・
// 昇格降格ルール・戦力帯を用意する。
// 「2軍」だけは最上位(10段階目)には昇格できない(9段階目が上限)。
// U-12は所持数(最大5チーム)ぶん、それぞれ独立した別々のリーグに在籍し、他の年代と同様
// 単純な昇格降格を行う(3段階目までを複数地域に分けて実装しているだけで、特別な合流処理は無い)。
const ACADEMY_TIER_COUNT = 10;
const ACADEMY_TIER_NAMES = ['町・区リーグ', '市リーグ', '地方2部', '地方1部', '全国D', '全国C', '全国B', '全国A', '大陸チャレンジ', '世界エリート'];
const ACADEMY_TIER_META = Array.from({ length: ACADEMY_TIER_COUNT }, (_, i) => ({
  promote: i === ACADEMY_TIER_COUNT - 1 ? 0 : 3,
  relegate: i === 0 ? 0 : 3,
}));
const RESERVE_MAX_TIER_IDX = ACADEMY_TIER_COUNT - 2; // 2軍はワールド相当(最終段階)には昇格できない

const ACADEMY_LEAGUE_CATEGORY = {
  reserve: 'reserve', reserve3: 'reserve3', reserve4: 'reserve4', reserve5: 'reserve5',
  youth: 'youth', youthReserve: 'youth',
  juniorYouth: 'juniorYouth', juniorYouthReserve: 'juniorYouth',
  u12_1: 'u12', u12_2: 'u12', u12_3: 'u12', u12_4: 'u12', u12_5: 'u12',
};
// 各カテゴリの1段階目(初期値)。下部組織の中で最も上級の「2軍」を15(トップチームの初期値と
// 同じ)を上限とし、年代が幼いほどそれより低い値にする。2段階目以降はTIER_BASELINEと同じ
// 考え方(buildBaselineLadder、下位リーグの理論上の2位=上位リーグの理論上の下から2位)で、
// リーグが上がるごとの上昇幅を積み上げて算出する。3〜5軍は2軍(15)から段階的に下げた値を
// 使い、同じreserveプールの中でも「下の階層ほどAI対戦相手も弱め」になるようにする。
const ACADEMY_BASELINE_INITIAL = {
  reserve: 15,
  reserve3: 13,
  reserve4: 11,
  reserve5: 9,
  youth: 11,
  juniorYouth: 8,
  u12: 6,
};
// アカデミーのティア数(ACADEMY_TIER_COUNT)はトップチームのティア数と同じ10段階なので、
// 帯域の半幅もTIER_HALF_WIDTHをそのまま流用する(下部組織も同じく下位リーグほど拮抗させる)。
const ACADEMY_BASELINE_LADDER = Object.fromEntries(
  Object.entries(ACADEMY_BASELINE_INITIAL).map(([cat, initial]) => [cat, buildBaselineLadder(initial, TIER_HALF_WIDTH)])
);

function academyBaselineForTier(cat, tierIdx) {
  return ACADEMY_BASELINE_LADDER[cat][tierIdx];
}

function academyLeagueMaxTierIdx(key) {
  return RESERVE_LEVEL_KEYS.includes(key) ? RESERVE_MAX_TIER_IDX : ACADEMY_TIER_COUNT - 1;
}

function academyLeagueLabel(key) {
  return YOUTH_TEAM_META[key].label;
}

// academyLeagueLabelと同じだが、'top'(YOUTH_TEAM_METAに存在しない)も扱えるようにしたもの。
// adultLeaguesのmemberKeysには'top'も混ざりうるため、それらを表示に使う箇所で使う。
function adultKeyLabel(key) {
  return key === 'top' ? 'トップ' : academyLeagueLabel(key);
}

// 2軍〜5軍はトップチームと同じリーグ体系(TIER_META)を共有する(ユーザー要望: 「同じリーグ体系」)。
// それ以外(ユース/ジュニアユース/U-12)は引き続き汎用ラダー(ACADEMY_TIER_META/ACADEMY_TIER_NAMES)を使う。
// 段数(ACADEMY_TIER_COUNT===TIER_META.length===10)と昇降格の形が既に同一のため、名称の参照先を
// 出し分けるだけで成立する。
function tierNamesForKey(key) {
  return RESERVE_LEVEL_KEYS.includes(key) ? TIER_META.map(t => t.name) : ACADEMY_TIER_NAMES;
}
function tierMetaForKey(key, tierIdx) {
  return RESERVE_LEVEL_KEYS.includes(key) ? TIER_META[tierIdx] : ACADEMY_TIER_META[tierIdx];
}

// 「本体プール」を総合力降順に並べ、階層(段階)ごとに均等な人数ずつ機械的に切り出す汎用の仕組み。
// reserve(2〜5軍)は4段階均等ADULT_SQUAD_BASE_CAP(26)人ずつ(2軍=上位26人・3軍=次の26人…)。
// ユース/ジュニアユースは「2軍」チームを所持している場合のみ2段階目(本体と同じ人数ぶん)が
// 生まれ、本体=上位、2軍=次点、という同じ考え方の階層になる(未所持の場合は本体1段階のみ)。
const TIER_GROUPS = {
  reserve: { levels: RESERVE_LEVEL_KEYS, levelCap: ADULT_SQUAD_BASE_CAP },
  youth: { levels: ['youth', 'youthReserve'], levelCap: YOUTH_CATEGORY_BASE_CAP },
  juniorYouth: { levels: ['juniorYouth', 'juniorYouthReserve'], levelCap: YOUTH_CATEGORY_BASE_CAP },
};
const TIER_GROUP_OF_KEY = {};
Object.entries(TIER_GROUPS).forEach(([baseCat, group]) => {
  group.levels.forEach(key => { TIER_GROUP_OF_KEY[key] = baseCat; });
});
// 2段階目以降(3軍/4軍/5軍・ユース2軍・ジュニアユース2軍)。reserveは本体(2軍)自体も
// 新設直後は空のためこのガード対象(RESERVE_LEVEL_KEYSに含まれる)。ユース/ジュニアユースの
// 本体(新設直後は選手0人)も、実在の選手プールから戦力を算出する以上は同じガードが必要なため、
// 2軍チームと同様に11人組めるまで参戦させない。
const TIER_GATED_KEYS = [...RESERVE_LEVEL_KEYS, 'youth', 'youthReserve', 'juniorYouth', 'juniorYouthReserve'];
// TIER_GATED_KEYSのうち、独自の週次クロックを持つ旧エンジン(simulateAcademyLeaguesRound)側で
// 引き続き毎節判定するもの。2〜5軍(RESERVE_LEVEL_KEYS)はトップと表を共有するため
// updateAdultLeagueParticipation()でシーズン境界のみ判定する(下記参照)。
const YOUTH_TIER_GATED_KEYS = ['youth', 'youthReserve', 'juniorYouth', 'juniorYouthReserve'];

function tieredLevelPool(key) {
  const baseCat = TIER_GROUP_OF_KEY[key];
  if (!baseCat) return [];
  const group = TIER_GROUPS[baseCat];
  const idx = group.levels.indexOf(key);
  const sorted = state.club.academy.prospects
    .filter(p => p.category === baseCat)
    .sort((a, b) => b.overall - a.overall);
  return sorted.slice(idx * group.levelCap, (idx + 1) * group.levelCap);
}

// 2軍/3軍/4軍/5軍を個別のタブ・セクションとして表示する際の保持人数上限(所持していれば
// 26人固定)。categoryCapacity('reserve')は所持中の階層をまとめた合計値(選手の自動配属先
// 判定用)のため、個別表示にはこちらを使う。
function reserveLevelCapacity(key) {
  return isCategoryOwned(key) ? ADULT_SQUAD_BASE_CAP : 0;
}

// 2軍以下の階層はプールを能力順に切り出したスライスなので、新設直後や選手の移籍・引き抜きに
// より11人(試合が組める最少人数)を割り込むことがある。11人に満たない間はリーグに
// 参戦させない(=academyLeagues[key]をnullのまま保つ)。
const RESERVE_MIN_SQUAD_SIZE = 11;
function tieredTeamCanField(key) {
  return tieredLevelPool(key).length >= RESERVE_MIN_SQUAD_SIZE;
}

// 毎節、ユース/ユース2軍/ジュニアユース/ジュニアユース2軍(YOUTH_TIER_GATED_KEYS、独自クロックを
// 持つ旧エンジン側)がそれぞれ「11人組めるか」を確認し、参戦状態を更新する。
// ・未参戦(league無し)で11人組めるようになった → 一番下のリーグ(またはreserveRejoinTierに
//   記録された、直前に降格した1つ下のリーグ)の最下位から新規に参戦を開始する。
// ・参戦中に11人を割り込んだ → 今シーズンの参戦を中断する。次に11人揃った際は現在のリーグの
//   1つ下(既に最下層なら同じ最下層)の最下位から再開できるよう、rejoin先のティアを記録しておく。
function updateReserveLeagueParticipation() {
  YOUTH_TIER_GATED_KEYS.forEach(key => {
    if (!state.club.youthTeams[key]) return;
    const league = state.club.academyLeagues[key];
    const canField = tieredTeamCanField(key);
    if (!league && canField) {
      const rejoinTier = state.club.reserveRejoinTier[key] || 0;
      startAcademyLeagueSeason(key, rejoinTier);
      addLog(`${academyLeagueLabel(key)}が${RESERVE_MIN_SQUAD_SIZE}人のチームを組めるようになり、${tierNamesForKey(key)[rejoinTier]}から参戦を開始しました。`, 'good');
    } else if (league && !canField) {
      state.club.reserveRejoinTier[key] = Math.max(league.tier - 1, 0);
      state.club.academyLeagues[key] = null;
      addLog(`${academyLeagueLabel(key)}が${RESERVE_MIN_SQUAD_SIZE}人に満たなくなり、今シーズンの参戦を中断しました。次に参戦できるようになった際は${tierNamesForKey(key)[state.club.reserveRejoinTier[key]]}の最下位から再開します。`, 'bad');
    }
  });
}

// シーズン開始時(startSeason()内)に1回だけ、2〜5軍(RESERVE_LEVEL_KEYS)がそれぞれ
// 「11人組めるか」を確認し、今シーズン参戦するかどうかを確定する。トップと表を共有するには
// 週次クロックを合わせる必要があるため、毎節ではなくシーズン境界でのみ判定する
// (=シーズン途中で11人揃っても、参戦は次シーズン開始からになる)。
function updateAdultLeagueParticipation() {
  RESERVE_LEVEL_KEYS.forEach(key => {
    if (!state.club.youthTeams[key]) { state.club.reserveActive[key] = false; return; }
    const wasActive = state.club.reserveActive[key];
    const canField = tieredTeamCanField(key);
    if (!wasActive && canField) {
      const rejoinTier = state.club.reserveRejoinTier[key] || 0;
      state.club.reserveTier[key] = rejoinTier;
      state.club.reserveActive[key] = true;
      addLog(`${academyLeagueLabel(key)}が${RESERVE_MIN_SQUAD_SIZE}人のチームを組めるようになり、${tierNamesForKey(key)[rejoinTier]}から今シーズン参戦します。`, 'good');
    } else if (wasActive && !canField) {
      state.club.reserveRejoinTier[key] = Math.max(state.club.reserveTier[key] - 1, 0);
      state.club.reserveActive[key] = false;
      addLog(`${academyLeagueLabel(key)}が${RESERVE_MIN_SQUAD_SIZE}人に満たなくなり、今シーズンの参戦を見送ります。次に参戦できるようになった際は${tierNamesForKey(key)[state.club.reserveRejoinTier[key]]}から参戦します。`, 'bad');
    }
  });
}

// リーグ内での自クラブの戦力: U-12の各チーム(u12_1〜5)は、同じ育成プールを共有していても
// リーグ上は別チーム(=別地域のクラブ)として扱うため、シーズンごとに個別のランダムな
// 戦力値(myStrength、ティアの目安帯から算出)を割り当てる。TIER_GROUPSに属するカテゴリ
// (2〜5軍・ユース/ユース2軍・ジュニアユース/ジュニアユース2軍)は、同じプールを能力順に
// 切り出したスライス(tieredLevelPool)から算出する。それ以外(U-12)は、これまで通り
// アカデミー在籍選手(プール)全体の実力から算出する。
function academyLeagueTeamStrength(key) {
  const league = state.club.academyLeagues[key];
  let base;
  if (league && league.myStrength != null) {
    base = league.myStrength;
  } else if (TIER_GROUP_OF_KEY[key]) {
    base = teamStrength(tieredLevelPool(key));
  } else {
    const cat = ACADEMY_LEAGUE_CATEGORY[key];
    const pool = state.club.academy.prospects.filter(p => p.category === cat);
    base = teamStrength(pool);
  }
  return base + coachMatchBonus(key);
}

// ---------- 提携クラブ ----------
// 20クラブの候補から提携できる。提携には自クラブの戦力が相手クラブの戦力を
// 一定以上(affiliateStrengthMargin())上回っている必要がある。施設レベル(facilityLevel)と
// 育成方針(focus)に応じて在籍選手の戦力・年代が変わり、シーズン(年)が変わるタイミングで
// 新しい選手が加入しお金を払って獲得できる。選手が引退した際、提携クラブがあればコーチとして
// 斡旋し一時金を得られる(=提携のメリット)。
// 提携クラブ上限はクラブの所属リーグ級(tier)に連動して段階的に広がる。序盤(tier0)は
// 従来通り3つに絞って難易度を保ちつつ、昇格を重ねるほど上限が伸び、最上位tierでは
// 企画書の「理論上10以上」に近い数まで提携できるようにする。
const AFFILIATE_POOL_SIZE = 20;
const AFFILIATE_MAX_BASE = 3;
const AFFILIATE_MAX_PER_TIER = 2;
function affiliateMax(tierIdx = state.club.tier) {
  return AFFILIATE_MAX_BASE + tierIdx * AFFILIATE_MAX_PER_TIER;
}
// 提携候補の目安戦力・必要マージンは、以前は絶対値(87・11)で固定されていたため、自クラブが
// 昇格してteamStrengthがTIER_BASELINEに沿って伸びても、提携候補のプール自体は序盤の強さの
// ままになってしまっていた(このプールはnewGame()時に一度生成されるだけで、以前は
// シーズンごとの再生成もしていなかった)。他の発掘経路(移籍市場・アカデミー)と同じく、
// 現在ティアのTIER_BASELINE/TIER_HALF_WIDTHを基準にした相対値へ改める。
// 係数0.85・0.4は、旧実装の絶対値(tier1相当で87・11)と近い相対位置になるよう逆算した値。
const AFFILIATE_STRENGTH_FACTOR = 0.85;
const AFFILIATE_STRENGTH_MARGIN_RATIO = 0.4;
function affiliateStrengthMargin(tierIdx = state.club.tier) {
  return Math.round(TIER_HALF_WIDTH[tierIdx] * AFFILIATE_STRENGTH_MARGIN_RATIO);
}

// tierIdx: 提携候補プールを生成する基準ティア(既定は自クラブの現在ティア)。
function generateAffiliateCandidates(tierIdx = state.club.tier) {
  const baseline = Math.round(TIER_BASELINE[tierIdx] * AFFILIATE_STRENGTH_FACTOR);
  const halfWidth = TIER_HALF_WIDTH[tierIdx];
  const strengths = buildAiStrengths(baseline, AFFILIATE_POOL_SIZE, halfWidth);
  const usedNames = new Set(state.club ? [state.club.name] : []);
  return strengths.map((strength, i) => {
    let name;
    do { name = genClubName(); } while (usedNames.has(name));
    usedNames.add(name);
    // strengthが帯域[baseline-halfWidth, baseline+halfWidth]の中でどの位置にあるかを
    // 1〜5の施設レベルに変換する(絶対値ではなく相対位置で見るため、ティアが変わっても
    // 同じ基準で1〜5に収まる)。
    const posRatio = clamp((strength - (baseline - halfWidth)) / (halfWidth * 2), 0, 1);
    const facilityLevel = clamp(Math.round(1 + posRatio * 4) + randInt(-1, 1), 1, 5);
    const focus = Math.random() < 0.5 ? 'young' : 'balanced';
    return { id: 'aff_' + uid(), name, strength, facilityLevel, focus };
  });
}

// シーズンごとに提携候補プールを現在のティアに合わせて更新する。既に提携済みのクラブ
// (state.club.affiliatesにidが残っているもの)は強さ・施設Lvを変えずそのまま維持し、
// 未提携の枠だけを現在ティア基準の新しい候補に入れ替える(提携済みクラブの参照が
// 壊れないようにするため、プール全体を作り直すことはしない)。
function refreshAffiliateCandidates() {
  if (!state.affiliateCandidates) state.affiliateCandidates = [];
  const joinedIds = new Set(state.club.affiliates);
  const kept = state.affiliateCandidates.filter(c => joinedIds.has(c.id));
  const freshCount = Math.max(0, AFFILIATE_POOL_SIZE - kept.length);
  const usedNames = new Set([...kept.map(c => c.name), state.club.name]);
  const fresh = generateAffiliateCandidates(state.club.tier).slice(0, freshCount);
  fresh.forEach(c => {
    while (usedNames.has(c.name)) c.name = genClubName();
    usedNames.add(c.name);
  });
  state.affiliateCandidates = [...kept, ...fresh];
}

// 企画書12.3(柱2): 提携がまだ1つも無いときに結ぶ「初の提携」は加入費 ×0.5。
// 提携が1つだけの間は維持費も ×0.6(2つ目を持つと通常料金に戻る)。多層経営の入口を
// 安くして「まず触らせる」ための割引。
const FIRST_AFFILIATE_JOIN_DISCOUNT = 0.5;
const SOLE_AFFILIATE_MAINT_DISCOUNT = 0.6;

function affiliateJoinCost(candidate) {
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  const discount = state.club.affiliates.length === 0 ? FIRST_AFFILIATE_JOIN_DISCOUNT : 1;
  return Math.round((120 + candidate.strength * 5) * tierMult * discount);
}

function affiliateMaintenanceCost(candidate) {
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  const discount = state.club.affiliates.length <= 1 ? SOLE_AFFILIATE_MAINT_DISCOUNT : 1;
  return Math.round((5 + candidate.strength * 0.35) * tierMult * discount);
}

function totalAffiliateMaintenance() {
  return state.club.affiliates.reduce((sum, id) => {
    const c = state.affiliateCandidates.find(cc => cc.id === id);
    return sum + (c ? affiliateMaintenanceCost(c) : 0);
  }, 0);
}

// ---------- 発掘候補の生成基準(ティア追従) ----------
// AI対戦相手(buildAiStrengths)は「そのティアの目安帯(baseline±half-width)」に沿って
// 生成されており、リーグティアが上がるほど際限なく強くなっていく。これに対して選手個々の
// 生成(移籍市場・アカデミー・提携クラブ)が絶対値で頭打ちになっていると、ティアが数段階
// 上がった時点で「AI相手はどんどん強くなるのに自チームの選手は昔の上限に張り付いたまま」
// という詰み状態になる。tierRelativeOverall()はAI生成と同じ物差し(baseline±half-width)を
// 選手個々の生成にも使うことで、ティアが上がるほど生成レンジそのものも一緒に釣り上がる
// ようにする。
function tierRelativeOverall(baseline, halfWidth, intensity) {
  const ratio = clamp(intensity, 0, 1);
  // 大半は帯域の下寄り(=まだ粗削り)に集まり、発掘網(スカウトLv/施設Lv)が強いほど
  // 上振れしやすくなる(makeMarketPlayerの「山なりの分布」と同じ考え方)。
  const belowBias = randInt(0, halfWidth);
  const scoutLift = Math.round(halfWidth * ratio * 0.8);
  const jitter = randInt(-Math.round(halfWidth * 0.15), Math.round(halfWidth * 0.15));
  return clamp(Math.round(baseline - belowBias + scoutLift + jitter), 5, ABILITY_CAP);
}

// ---------- 潜在能力ガードレール ----------
// 「発掘網さえ広げ続ければ、どの経路からでも際限なく超一流が手に入る」ことを防ぐための
// 年代・経路別の壁。「何ティア先まで化ける余地を見込むか(POTENTIAL_AHEAD_TIERS)」を
// 年代が若いほど大きく取ることで、若い年代ほど将来の伸びしろの絶対値も大きくなる
// (=規格外の逸材に手が届く)一方、その最上位帯(ブレイク枠)の出現率自体は低く抑える。
// ceiling/bandはtierRelativeOverall()と同じ「baseline±half-width」の物差しで算出するため、
// ティアが上がるほどこのガードレール自体も一緒に釣り上がっていく(絶対値では頭打ちにならない)。
const POTENTIAL_AHEAD_TIERS = { u12: 4, juniorYouth: 3, youth: 2, affiliate: 1, market: 1 };
const POTENTIAL_BREAKTHROUGH_CHANCE = {
  u12:         { min: 0.03, max: 0.08 },
  juniorYouth: { min: 0.05, max: 0.12 },
  youth:       { min: 0.08, max: 0.18 },
  affiliate:   { min: 0.05, max: 0.15 },
  market:      { min: 0.05, max: 0.12 },
};
function potentialGuardrailBand(category, tierIdx, overall) {
  const ahead = POTENTIAL_AHEAD_TIERS[category] || 1;
  const targetTier = Math.min(tierIdx + ahead, TIER_BASELINE.length - 1);
  const targetBaseline = (category === 'market' || category === 'affiliate')
    ? TIER_BASELINE[targetTier]
    : academyBaselineForTier(category, targetTier);
  // overallが既に(帯域上振れなどで)素のceiling見積もりを超えている場合に備え、
  // 必ずoverall以上になるよう安全側に補正する。
  const ceiling = Math.max(overall, clamp(Math.round(targetBaseline + TIER_HALF_WIDTH[targetTier] * 0.6), 5, ABILITY_CAP));
  const bandLo = Math.min(ceiling, Math.max(overall, Math.round(ceiling - TIER_HALF_WIDTH[tierIdx] * 2.2), Math.round(ceiling * 0.55)));
  return { ceiling, bandLo };
}
// overall: 発掘時点の現在能力。tierIdx: そのカテゴリの現在ティア。intensity: 0〜1の発掘網の強さ。
function applyPotentialGuardrail(overall, category, tierIdx, intensity) {
  const chanceCfg = POTENTIAL_BREAKTHROUGH_CHANCE[category];
  if (!chanceCfg) return clamp(overall + randInt(5, 20), overall, ABILITY_CAP);
  const { ceiling, bandLo } = potentialGuardrailBand(category, tierIdx, overall);
  const ratio = clamp(intensity, 0, 1);
  const breakthroughChance = chanceCfg.min + (chanceCfg.max - chanceCfg.min) * ratio;
  if (Math.random() < breakthroughChance) {
    return clamp(randInt(bandLo, ceiling), overall, ABILITY_CAP);
  }
  const normalCeiling = Math.max(overall, Math.min(bandLo - 1, ceiling));
  const headroom = Math.round((normalCeiling - overall) * (0.3 + 0.5 * ratio));
  return clamp(overall + Math.max(0, headroom), overall, normalCeiling);
}

// 提携クラブの施設レベル(戦力・質)とfocus(育成方針、年代の傾向)に応じて在籍選手を生成する。
// candidate.strengthは「提携クラブ間の相対的な格」を表すだけの値なので、選手個々の絶対値は
// (提携クラブ固有の値ではなく)自クラブが今いるティアの目安帯を基準にする。これにより、
// 自クラブが昇格するほど提携クラブから供給される選手のレベルも一緒に底上げされる。
function makeAffiliatePlayer(candidate) {
  const age = candidate.focus === 'young' ? randInt(15, 20) : randInt(18, 27);
  const tierIdx = state.club.tier;
  const baseline = TIER_BASELINE[tierIdx];
  const halfWidth = TIER_HALF_WIDTH[tierIdx];
  const intensity = candidate.facilityLevel / 5;
  const overall = tierRelativeOverall(baseline, halfWidth, intensity);
  const pos = weightedPosition();
  const player = createPlayer(pos, age, overall);
  if (age <= 21) {
    player.potential = applyPotentialGuardrail(player.overall, 'affiliate', tierIdx, intensity);
  }
  const tierMult = TIER_PRICE_MULT[state.club.tier];
  player.price = Math.round((player.overall * 7 + player.potential * 8) * tierMult * (0.8 + Math.random() * 0.3));
  return player;
}

// 提携中の各クラブの在籍選手を入れ替える。シーズン開始(=年が変わるタイミング)ごとに呼ばれる。
function refreshAffiliateRosters() {
  state.club.affiliates.forEach(id => {
    const candidate = state.affiliateCandidates.find(c => c.id === id);
    if (!candidate) return;
    const count = 3 + candidate.facilityLevel;
    state.affiliateRosters[id] = Array.from({ length: count }, () => makeAffiliatePlayer(candidate));
  });
}

// 引退選手をコーチとして提携クラブへ斡旋し、一時金を得る(提携クラブがある場合のみ)。
function brokerRetiredPlayersAsCoaches(retiredPlayers) {
  const affCount = state.club.affiliates.length;
  if (affCount === 0 || !retiredPlayers.length) return 0;
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  return retiredPlayers.reduce((sum, p) => {
    return sum + Math.round(p.overall * 3 * tierMult * (1 + affCount * 0.15));
  }, 0);
}

// ---------- スポンサー ----------
// 全体スポンサーは最初は1枠(小さな地元スポンサー)のみ。クラブの評判(=成績の積み重ね)が
// 上がるほど枠が解放されていき、最大 SPONSOR_GENERAL_SLOTS 枠まで増える。
// さらにユース/ジュニアユース/U-12をそれぞれ1チーム以上所持していれば、その年代向けの
// 専用スポンサー枠が1つずつ解放される(合計最大10枠)。
// どのスポンサーも所属ティア(SPONSOR_GRADE、地元→地方→日本の大企業→世界的大企業)に
// 応じた名前の候補プールから選ばれ、ティアが上がるほど格上げされた候補が登場するようになる。
// 契約は SPONSOR_CONTRACT_SEASONS シーズンで満了し、再契約(新しい候補から選び直す)が必要。
// 金銭収入に加え、契約中は選手の成長速度に効く「成長ボーナス」効果を持ち、契約時には
// クラブの知名度が上がる一時的な評判ボーナスも得られる(大企業ほど効果が大きい)。
const SPONSOR_GENERAL_SLOTS = 7;
const SPONSOR_CONTRACT_SEASONS = 3;
const SPONSOR_CANDIDATE_COUNT = { youth: 3, juniorYouth: 3, u12: 3 };
// 全体スポンサーの枠は評判値がここに達するたびに1つずつ解放される(0番目は最初から解放済み)。
const SPONSOR_SLOT_UNLOCK_REP = [0, 150, 350, 550, 750, 900, 1000];
// ティア(0:地域アマチュア〜9:ワールドスーパー)に対応するスポンサーの「格」。
const SPONSOR_GRADE_LABEL = [
  '地元スポンサー', '市のスポンサー', '地方の新興スポンサー', '地方スポンサー', '国内中堅スポンサー',
  '国内大手スポンサー', '日本の大手スポンサー', '大陸スポンサー', '大陸の大手スポンサー', '世界的大企業スポンサー',
];

const SPONSOR_NAME_POOL = {
  // 全体スポンサー: ティアが上がるほど地元の個人商店 → 市 → 地方 → 国内大手 → 大陸 → 世界的大企業へと格上げされる。
  general: [
    ['まちの八百屋さん', '中央商店会', 'わかば信用金庫', 'ふるさと食堂', '駅前クリーニング'],
    ['みなと商工会', '市立競技場前カフェ', 'つばさ信用金庫', '中央郵便局前薬局', 'シーサイド市場'],
    ['蒼海不動産', '北斗物流', 'さくら製菓', 'リバーサイド建設', '緑風タクシー'],
    ['湘南地所', '北陸フーズ', '中央信販', '東海実業', 'ベイエリア放送'],
    ['オリオン損保', '桜花フーズ', '第一物流ホールディングス', '若葉銀行', 'テラ製薬'],
    ['朝日重工業', '扶桑製鉄', '極東放送', '大陸物流ホールディングス', '青嵐フーズ'],
    ['大和ホールディングス', '太平洋銀行', '東亜自動車', 'サンライズ生命保険', 'セントラル製薬', 'ユニオン製鉄', 'メトロ百貨店'],
    ['パンオーシャン航空', 'コンチネンタル製薬', 'メガロポリス銀行', 'トランスコンチネンタル物流', 'ユーラシア重工'],
    ['コンチネンタル・エアウェイズ', 'グランドコンチネンタル銀行', 'パンゲア・モータース', 'メガコープ・エナジー', 'コンチネンタル・メディアグループ'],
    ['グローバルモータース', 'ユニバーサル・コーラ', 'ワールドワイド・エアラインズ', 'パンゲア・エレクトロニクス', 'コスモポリタン銀行', 'インターギャラクティック・スポーツ'],
  ],
  // ユース(高校生年代): エナジードリンク・スニーカー・音楽ガジェット・筋トレ・SNSなど、格はティアに連動。
  youth: [
    ['商店街スニーカー店', 'ローカルFMラジオ', '町のトレーニングジム'],
    ['市営ジム24', 'タウンスニーカーズ', '地元エナジーソーダ'],
    ['リージョナルスポーツ用品', 'ローカルヒーローアパレル', '地方FMミュージック'],
    ['リージョナルエナジー', '地方チェーンジム24', 'ベイエリアアパレル'],
    ['ナショナルエナジー', 'スプリントギア', 'ビートナウ・イヤホン'],
    ['ハイパーブースト飲料', 'ネクストラン アパレル', 'パルスビート ワイヤレス'],
    ['チャージアップエナジー', 'ストリートフライ スニーカーズ', 'ビートパルス ワイヤレスイヤホン', 'フレッシュブースト プロテイン', 'ナイトラン アパレル', 'クイックマート24', 'ハイテンションコーラ', 'リミットブレイク ジム'],
    ['コンチネンタルエナジー', 'パンオーシャン スニーカーズ', 'グランドフィットネス機構'],
    ['ユーラシアスポーツギア', 'コンチネンタルミュージック', 'メガブースト飲料'],
    ['グローバルスニーカーズ', 'ワールドエナジードリンク', 'インターナショナル ストリートウェア', 'プラネットフィットネス機構'],
  ],
  // ジュニアユース(中学生年代): 漫画・携帯ゲーム・駄菓子・カードゲームなど、格はティアに連動。
  juniorYouth: [
    ['商店街の駄菓子屋', '町のコミックレンタル', '近所のゲーム屋'],
    ['市営ゲームセンター', 'タウンコミック書店', '地元駄菓子問屋'],
    ['リージョナルカードショップ', '地方コミック配給', 'ベイエリアゲームズ'],
    ['地方チェーン菓子店', 'リージョナルコミック出版', 'タウンズゲームセンター'],
    ['ナショナルコミック出版', 'スーパーカードバトル', 'ハイパー駄菓子チェーン'],
    ['メガコミックネットワーク', 'ダッシュゲームズ全国版', 'クラッシュソーダ製菓'],
    ['爆速!ダッシュガム', '戦隊コミックブックス', 'タウンズコンビニ', 'スピードキック菓子店', 'バトルカードコロシアム', 'モンスターソーダ', 'ダッシュ!駄菓子店', 'ゲームパーク中央'],
    ['コンチネンタルコミック機構', 'パンオーシャンゲームズ', 'グランドカードバトル連盟'],
    ['ユーラシアコミック連合', 'メガロポリスゲームズ', 'コンチネンタルソーダ'],
    ['ワールドバトルカード機構', 'グローバルコミックネットワーク', 'プラネットソーダ', 'インターナショナルゲームズ'],
  ],
  // U-12(小学生年代): アイス・おもちゃ・ジュース・文房具など、格はティアに連動。
  u12: [
    ['近所のアイス屋さん', '町のおもちゃ屋', '商店街パン屋'],
    ['市営こどもプール売店', 'タウンおもちゃ店', '地元パン工房'],
    ['リージョナルアイスチェーン', '地方キッズショップ', 'ベイエリア文房具店'],
    ['地方アイスチェーン', 'リージョナルおもちゃ店', 'ベイサイドパン工房'],
    ['ナショナルキッズTV', 'ハッピーおもちゃ全国チェーン', 'にじいろジュース工場'],
    ['メガキッズランド', 'スマイルおもちゃ全国版', 'ふわふわクラウドジュース'],
    ['にこにこアイスクリーム', 'キラキラおもちゃ王国', 'わくわくスタジアムパン', 'ゆめいろジュース', 'ぴかぴか文房具', 'こどもチャンネル', 'ふわふわキャンディ', 'スマイルシューズキッズ'],
    ['コンチネンタルキッズTV', 'パンオーシャンおもちゃ王国', 'グランドアイスクリーム連合'],
    ['ユーラシアキッズネットワーク', 'メガロポリスおもちゃ帝国', 'コンチネンタルジュース機構'],
    ['ワールドおもちゃ王国', 'グローバルキッズTV', 'プラネットアイスクリーム', 'インターナショナルジュース機構'],
  ],
};

function sponsorCategoryLabel(cat) {
  return { general: '全体', youth: 'ユース', juniorYouth: 'ジュニアユース', u12: 'U-12' }[cat];
}

// 現在解放されている全体スポンサーの枠数(評判値に応じて1〜SPONSOR_GENERAL_SLOTS)。
function generalSponsorSlotsUnlocked() {
  return SPONSOR_SLOT_UNLOCK_REP.filter(req => state.club.reputation >= req).length;
}

function pickSponsorName(category, tierIdx, usedNames) {
  const pool = SPONSOR_NAME_POOL[category][tierIdx];
  const avail = pool.filter(n => !usedNames.has(n));
  const list = avail.length ? avail : pool;
  return list[randInt(0, list.length - 1)];
}

// 契約中は選手の成長速度に上乗せされる非金銭効果。格(tierIdx)が高いスポンサーほど、
// またpowerMult(個体差)が高いスポンサーほど効果が大きい。
function makeSponsorEffect(tierIdx, powerMult) {
  return { growth: +(0.2 + tierIdx * 0.35 + powerMult * 0.25).toFixed(2) };
}

function makeSponsorCandidate(category, usedNames) {
  const tierIdx = state.club.tier;
  const name = pickSponsorName(category, tierIdx, usedNames);
  usedNames.add(name);
  const powerMult = +(0.8 + Math.random() * 0.5).toFixed(2); // 0.80〜1.30。同じ枠でも収入に差が出る。
  return { id: uid(), name, tierIdx, powerMult, effect: makeSponsorEffect(tierIdx, powerMult) };
}

// 専用枠(ユース/ジュニアユース/U-12)は全体枠よりやや小さい基礎額にする
// (5枠に分散する全体枠に対し、専用枠は1枠だけの上乗せボーナス的な位置づけのため)。
function sponsorSlotWeeklyBase(category) {
  const tier = TIERS[state.club.tier];
  return category === 'general' ? tier.sponsorWeekly / SPONSOR_GENERAL_SLOTS : tier.sponsorWeekly * 0.16;
}

// スポンサー単価はクラブランクスコア(トップ成績だけでなく施設・財政・育成実績まで
// 統合した0-1000点)に連動させる。評判(topResults)単体より格上のクラブ評価を反映できる。
function sponsorEstIncome(slotOrCandidate, category) {
  const rankScore = computeClubRank().score;
  const rankFactor = 0.6 + rankScore / 1500;
  return Math.round(sponsorSlotWeeklyBase(category) * slotOrCandidate.powerMult * rankFactor);
}

function sponsorWeeklyIncome(slot, category) {
  if (!slot) return 0;
  const rankScore = computeClubRank().score;
  const rankFactor = 0.6 + rankScore / 1500;
  const variance = 0.85 + Math.random() * 0.3;
  return Math.round(sponsorSlotWeeklyBase(category) * slot.powerMult * rankFactor * variance);
}

function totalSponsorWeeklyIncome() {
  let total = 0;
  state.club.sponsors.general.forEach(s => { total += sponsorWeeklyIncome(s, 'general'); });
  ['youth', 'juniorYouth', 'u12'].forEach(cat => { total += sponsorWeeklyIncome(state.club.sponsors[cat], cat); });
  return total;
}

// 契約中のスポンサーによる成長ボーナス合計。scope='top'は全体スポンサーの合計(トップチームに効く)、
// それ以外(youth/juniorYouth/u12)は該当専用枠1つぶんの効果を返す。
function sponsorGrowthBonus(scope) {
  if (scope === 'top') {
    return state.club.sponsors.general.reduce((s, sp) => s + (sp ? sp.effect.growth : 0), 0);
  }
  const sp = state.club.sponsors[scope];
  return sp ? sp.effect.growth : 0;
}

function generateSponsorCandidates(category) {
  const usedNames = new Set();
  if (category === 'general') {
    state.club.sponsors.general.forEach(s => { if (s) usedNames.add(s.name); });
  } else if (state.club.sponsors[category]) {
    usedNames.add(state.club.sponsors[category].name);
  }
  // 全体スポンサーの候補数は解放枠数に応じて増やす(成績が良いほど選べる候補も増えていく)。
  const count = category === 'general' ? clamp(generalSponsorSlotsUnlocked() + 1, 2, 6) : SPONSOR_CANDIDATE_COUNT[category];
  state.sponsorCandidates[category] = Array.from({ length: count }, () => makeSponsorCandidate(category, usedNames));
}

// シーズン開始のたびに、所持している年代の候補スポンサーを更新する(移籍市場と同じ考え方)。
function refreshSponsorCandidatesAll() {
  generateSponsorCandidates('general');
  ['youth', 'juniorYouth', 'u12'].forEach(cat => {
    if (isCategoryOwned(cat)) generateSponsorCandidates(cat);
  });
}

// 新規クラブ発足時は、小さな地元スポンサー1枠だけ契約済みの状態で始める
// (でないと初週から収入がゼロになってしまうため)。残りの枠は成績(評判)を上げて解放していく。
function autoSignInitialSponsor() {
  if (state.club.sponsors.general[0]) return;
  const usedNames = new Set();
  const candidate = makeSponsorCandidate('general', usedNames);
  state.club.sponsors.general[0] = { ...candidate, seasonsLeft: SPONSOR_CONTRACT_SEASONS };
}

// クラブの知名度が上がるスポンサー契約ほど、契約時にわずかな評判ボーナスを即座に得られる
// (地元スポンサーは0、世界的大企業なら最大+6)。最大7枠×3シーズンごとに再契約が発生するため、
// ここを大きくしすぎると下位ティアのまま契約更新を繰り返すだけで評判が積み上がってしまう。
function sponsorSignReputationBonus(tierIdx) {
  const ranges = [[0, 0], [0, 0], [0, 2], [0, 2], [2, 2], [2, 3], [2, 3], [2, 5], [3, 5], [3, 6]];
  const [lo, hi] = ranges[tierIdx];
  return hi > 0 ? randInt(lo, hi) : 0;
}

// 空き枠が無い状態で候補を選んだ場合は replaceIndex(全体スポンサーは枠番号、専用枠は何でもよい)
// で入れ替え対象を指定することで、既存の契約を解消しつつ新しいスポンサーと契約できる。
// これにより、今の契約を先に解消しなくても新しい候補を探して契約先を切り替えられる。
function signSponsor(category, candidateId, replaceIndex) {
  const list = state.sponsorCandidates[category];
  if (!list) return;
  const idx = list.findIndex(c => c.id === candidateId);
  if (idx < 0) return;
  const candidate = list[idx];
  let releasedName = null;
  if (category === 'general') {
    const unlocked = generalSponsorSlotsUnlocked();
    let slotIdx = state.club.sponsors.general.findIndex((s, i) => !s && i < unlocked);
    if (slotIdx < 0) {
      if (replaceIndex === undefined || replaceIndex === null || replaceIndex === '') { toast('入れ替える契約先を選択してください'); return; }
      slotIdx = Number(replaceIndex);
      const current = state.club.sponsors.general[slotIdx];
      if (slotIdx < 0 || slotIdx >= unlocked || !current) { toast('入れ替え先が不正です'); return; }
      releasedName = current.name;
    }
    state.club.sponsors.general[slotIdx] = { ...candidate, seasonsLeft: SPONSOR_CONTRACT_SEASONS };
  } else {
    if (!isCategoryOwned(category)) { toast('対象年代のチームを先に所持してください'); return; }
    if (state.club.sponsors[category]) { releasedName = state.club.sponsors[category].name; }
    state.club.sponsors[category] = { ...candidate, seasonsLeft: SPONSOR_CONTRACT_SEASONS };
  }
  list.splice(idx, 1);
  const repBonus = sponsorSignReputationBonus(candidate.tierIdx);
  let repText = '';
  if (repBonus > 0) {
    state.club.reputation = clamp(state.club.reputation + repBonus, 0, reputationCapForTier(state.club.tier));
    repText = ` クラブの知名度が上がり評判 +${repBonus}。`;
  }
  const releaseText = releasedName ? `${releasedName}との契約を解消し、` : '';
  addLog(`${releaseText}${candidate.name}(${SPONSOR_GRADE_LABEL[candidate.tierIdx]})とスポンサー契約を結びました。(契約期間: 残り${SPONSOR_CONTRACT_SEASONS}シーズン、成長ボーナス+${candidate.effect.growth})${repText}`, 'good');
  save();
  render();
}

function releaseSponsor(category, slotIndex) {
  if (category === 'general') {
    const s = state.club.sponsors.general[slotIndex];
    if (!s) return;
    state.club.sponsors.general[slotIndex] = null;
    addLog(`${s.name} とのスポンサー契約を解消しました。`);
  } else {
    const s = state.club.sponsors[category];
    if (!s) return;
    state.club.sponsors[category] = null;
    addLog(`${s.name} とのスポンサー契約を解消しました。`);
  }
  save();
  render();
}

// シーズン終了時に呼び出す: 契約中の全スポンサーの残りシーズンを1減らし、0になった契約は満了させる。
function tickSponsorContracts() {
  const expired = [];
  state.club.sponsors.general.forEach((s, i) => {
    if (!s) return;
    s.seasonsLeft -= 1;
    if (s.seasonsLeft <= 0) { expired.push(s.name); state.club.sponsors.general[i] = null; }
  });
  ['youth', 'juniorYouth', 'u12'].forEach(cat => {
    const s = state.club.sponsors[cat];
    if (!s) return;
    s.seasonsLeft -= 1;
    if (s.seasonsLeft <= 0) { expired.push(s.name); state.club.sponsors[cat] = null; }
  });
  if (expired.length) {
    addLog(`スポンサー契約が満了しました: ${expired.join('、')}。「スポンサー」タブで新しい契約先を選べます。`, 'gold');
  }
}

const CLUB_PREFIXES = ['アステリア','ノヴァ','エルデ','ヴァルト','ソレイユ','カルディア','ブレイズ','ノルテ','シルヴァ','ドラーゴ','フェニクス','リオグランデ','モンテ','アズーロ','グラナート','ステラ','オリオン','カスカータ','ヴェルデ','ルミナス'];
const CLUB_SUFFIXES = ['FC','ユナイテッド','アスレティック','シティ','レンジャーズ','ウィングス','ロイヤル','SC','アカデミー','コンバット'];
const FIRST_NAMES = ['カイト','レオン','ミゲル','ダリオ','ファビオ','トーマ','ルーカ','ニコ','ハビ','ソウマ','エリック','ヴィト','マルコ','ケンゾ','アルフ','ブルーノ','セルジオ','ヤン','ディエゴ','ラウル'];
const LAST_NAMES = ['シュヴァルツ','ロッシ','ペレイラ','ベルナル','キンダー','ノヴァク','ドラゴ','ヴァレンテ','オルテガ','フェレイラ','ハイド','モラレス','キリアン','ザイツ','コスタ','リベイロ','ブランコ','マイヤー','ソト','ヴィダル'];

// ---------- 競合クラブ(固定ライバル) ----------
// 毎シーズンランダム生成される匿名AIクラブとは別に、常に同じ名前で登場する3つの
// 「ライバルクラブ」を定義する。各クラブは年代(u12/ジュニアユース/ユース/2軍/トップ)ごとに
// 「今どのティアに位置しているか」を固定値で持ち、自クラブの各年代がそのティアに来ると
// AI枠の1つが差し替わってこのライバルが登場する。
// rivalImperial(最強): 下部年代から一貫してトップ(ワールドスーパーリーグ)まで勢力を持つ
// "帝国"。最初はu12(最も低いティア)で当たるところから始まり、自クラブが成長するたびに
// 同じ名前のクラブに、より上の年代・ティアで再会し続ける(=最終的な最大の目標)。
// rivalCondor/rivalPhoenixは少しずつティアを下げた"かなり強いが最強ではない"クラブで、
// 特にrivalPhoenixのu12は最初期のティアに設定してあり、「最初に追い抜くべき目標」になる。
// ティア内帯域(±そのティアの半幅)の上位寄りに位置させ、"そのティアの強豪"として立ちはだからせる。
// 半幅はティアごとに異なる(TIER_HALF_WIDTH)ため、固定量ではなく半幅に対する比率で持たせる
// (旧: 58幅のときに33 → 比率0.569。半幅が狭い下位ティアではボーナスも比例して小さくなる)。
const RIVAL_STRENGTH_RATIO = 33 / 58;
const RIVAL_CLUBS = [
  {
    id: 'rivalImperial',
    name: 'アルカディア・インペリアル',
    catchphrase: '下部年代から一貫指導する大陸随一の名門。ユースまでフル編成で抱え、頂点(ワールドスーパーリーグ)に君臨する。',
    tiers: { u12: 2, juniorYouth: 4, youth: 6, reserve: 7, top: 9 },
  },
  {
    id: 'rivalCondor',
    name: 'ノルテ・コンドル',
    catchphrase: '常に上位を狙う強豪。育成にも力を入れ、各年代で上位に食い込んでくる。',
    tiers: { u12: 1, juniorYouth: 3, youth: 4, reserve: 6, top: 7 },
  },
  {
    id: 'rivalPhoenix',
    name: 'フェニクス・ロイヤル',
    catchphrase: '着実に力をつけてきた新興の強豪。まずはこのクラブを追い抜くのが最初の目標になるだろう。',
    tiers: { u12: 0, juniorYouth: 2, youth: 3, reserve: 5, top: 6 },
  },
];

function rivalBaseline(category, tierIdx) {
  return category === 'top' ? TIER_BASELINE[tierIdx] : academyBaselineForTier(category, tierIdx);
}

function rivalStrength(rival, category) {
  const tierIdx = rival.tiers[category];
  const baseline = rivalBaseline(category, tierIdx);
  const bonus = Math.round(TIER_HALF_WIDTH[tierIdx] * RIVAL_STRENGTH_RATIO);
  return clamp(Math.round(baseline + bonus + randInt(-4, 4)), 5, ABILITY_CAP);
}

// teams/aiIds(AIクラブ生成後の枠)のうち、指定カテゴリ・ティアに該当するライバルクラブがいれば
// 枠を1つずつ固定名・固定戦力で上書きする。announce=trueのときは自クラブの現在のリーグに
// ライバルが登場したことをログで知らせる(トップリーグのみで使用し、ログの過多を防ぐ)。
function injectRivalClubs(teams, aiIds, category, tierIdx, announce, nameSuffix) {
  const matched = RIVAL_CLUBS.filter(r => r.tiers[category] === tierIdx);
  matched.forEach((rival, i) => {
    const id = aiIds[i];
    if (!id) return;
    teams[id] = { name: `${rival.name}${nameSuffix || ''}`, strength: rivalStrength(rival, category), rivalId: rival.id };
  });
  if (announce && matched.length) {
    addLog(`今シーズンは${TIERS[tierIdx].name}で強豪 ${matched.map(r => r.name).join('・')} と同じリーグで戦います。`, 'gold');
  }
  return matched;
}

// ---------- ユーティリティ ----------

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function choice(arr) { return arr[randInt(0, arr.length - 1)]; }

let uidCounter = 1;
function uid() { return 'p' + (uidCounter++) + '_' + Math.random().toString(36).slice(2, 7); }

function fmtMoney(v) {
  const sign = v < 0 ? '-' : '';
  v = Math.abs(Math.round(v));
  if (v >= 10000) {
    const oku = v / 10000;
    return `${sign}${oku.toFixed(oku >= 100 ? 0 : 1)}億円`;
  }
  return `${sign}${v.toLocaleString()}万円`;
}

// ---------- クラブランク(統合指標) ----------
// トップ成績・下部組織成績・施設レベル・財政健全度・育成輩出実績を加重合算した0-1000点の
// スコアと、それを20段階に区分した段階ラベルを算出する。このスコアは施設レベル上限・
// スポンサー単価・リーグ昇格条件など、複数の解放条件から共通して参照される「クラブの格」の
// 単一の物差しとして機能する(将来カップ戦参加資格などを追加する際もclubRankStage()を
// 参照すれば一貫性を保てる)。
const CLUB_RANK_STAGES = [
  { label: '草の根クラブ' },
  { label: '地域に根差すクラブ' },
  { label: '地域の新星' },
  { label: '地域の期待株' },
  { label: '地方の実力者' },
  { label: '地方の有力クラブ' },
  { label: '地方の強豪' },
  { label: '地方の盟主' },
  { label: '全国区の挑戦者' },
  { label: '全国に知られる存在' },
  { label: '全国的強豪' },
  { label: '全国有数の名門' },
  { label: '国内トップクラブ' },
  { label: '国内屈指の名門' },
  { label: '大陸に名を馳せる名門' },
  { label: '大陸有数の強豪' },
  { label: '大陸の盟主' },
  { label: '大陸を代表する名門' },
  { label: '世界に挑む強豪' },
  { label: '世界王者' },
];
const CLUB_RANK_WEIGHTS = { top: 0.35, lowerOrg: 0.20, facility: 0.15, financial: 0.15, development: 0.15 };
const CLUB_RANK_TARGET_RUNWAY_WEEKS = 8;

// トップ成績: reputation(順位実績の積み重ね、0-1000)を他の内訳項目と同じ0-100スケールに
// 正規化して使う(そのまま使うと加重合算のバランスが崩れるため)。
function clubRankTopScore() {
  return state.club.reputation / 10;
}

// 下部組織成績: 所持している下部組織リーグの「10段階中どこまで昇格したか」の平均(70%)と、
// 提携クラブの施設レベルの平均(30%)を合成する。どちらも未所持なら0、片方のみならその値を使う。
function clubRankLowerOrgScore() {
  // ユース以下(独自クロック): academyLeagues[key]が参戦中の証。
  const leagueTierRatios = Object.keys(state.club.academyLeagues)
    .filter(k => state.club.academyLeagues[k])
    .map(k => state.club.academyLeagues[k].tier / academyLeagueMaxTierIdx(k));
  // 2〜5軍(トップと表を共有しうる): academyLeagues[key]は使わないため、
  // reserveActive/reserveTierから参戦中のものだけ加える。
  RESERVE_LEVEL_KEYS.forEach(k => {
    if (state.club.reserveActive[k]) leagueTierRatios.push(state.club.reserveTier[k] / academyLeagueMaxTierIdx(k));
  });
  const leagueScore = leagueTierRatios.length
    ? leagueTierRatios.reduce((s, r) => s + r * 100, 0) / leagueTierRatios.length
    : 0;
  const affiliated = state.club.affiliates.map(id => state.affiliateCandidates.find(c => c.id === id)).filter(Boolean);
  const affiliateScore = affiliated.length
    ? affiliated.reduce((s, c) => s + (c.facilityLevel / 5) * 100, 0) / affiliated.length
    : 0;
  if (!leagueTierRatios.length) return affiliateScore;
  if (!affiliated.length) return leagueScore;
  return leagueScore * 0.7 + affiliateScore * 0.3;
}

// 施設レベル: 所持している各施設の「現在レベル÷基礎上限」の平均。ここでの分母は必ず
// 固定の基礎上限(*_BASE_MAX定数)を使うこと。クラブランクで伸びる動的上限
// (facilityMaxLevel等)を使うと、その関数がclubRankStage()を呼ぶため循環参照になる。
function clubRankFacilityScore() {
  const f = state.club.facilities;
  const ratios = [];
  const scoutBaseMax = (state.club.tier + 1) * SCOUT_LEVELS_PER_TIER;
  ratios.push(clamp(f.scout / scoutBaseMax, 0, 1));
  if (isCategoryOwned('anyYouth')) ratios.push(clamp(f.youthStadium / FACILITY_BASE_MAX, 0, 1));
  ['scoutYouth', 'scoutJuniorYouth', 'scoutU12'].forEach(key => {
    if (isCategoryOwned(FACILITY_META[key].requires)) ratios.push(clamp(f[key] / FACILITY_BASE_MAX, 0, 1));
  });
  GROUND_CATEGORY_ORDER.forEach(cat => {
    if (cat !== 'top' && !isCategoryOwned(cat)) return;
    Object.values(f.grounds[cat]).forEach(lv => ratios.push(clamp(lv / GROUND_FACILITY_BASE_MAX, 0, 1)));
  });
  ['top', 'reserve', 'reserveLower'].forEach(cat => {
    if (cat !== 'top' && !isCategoryOwned(cat)) return;
    Object.values(f.stadiums[cat]).forEach(lv => ratios.push(clamp(lv / STADIUM_FACILITY_BASE_MAX, 0, 1)));
  });
  ['top', 'reserve', 'reserveLower'].forEach(cat => {
    if (cat !== 'top' && !isCategoryOwned(cat)) return;
    ratios.push(clamp(f.shopStadium[cat] / SHOP_LOCATION_BASE_MAX, 0, 1));
  });
  GROUND_CATEGORY_ORDER.forEach(cat => {
    if (cat !== 'top' && !isCategoryOwned(cat)) return;
    ratios.push(clamp(f.shopGround[cat] / SHOP_LOCATION_BASE_MAX, 0, 1));
  });
  ratios.push(clamp(f.shopRegional / FACILITY_BASE_MAX, 0, 1));
  ratios.push(clamp(f.shopOnline / FACILITY_BASE_MAX, 0, 1));
  // shopOverseas/shopLicenseはclubRankStage()ではなくtier(継続的に判定可能)で解放されるため、
  // ここでも安全にisCategoryOwned('continental'/'worldStage')を参照できる(循環参照なし)。
  if (isCategoryOwned('continental')) ratios.push(clamp(f.shopOverseas / FACILITY_BASE_MAX, 0, 1));
  if (isCategoryOwned('worldStage')) ratios.push(clamp(f.shopLicense / FACILITY_BASE_MAX, 0, 1));
  SHOP_PRODUCT_KEYS.forEach(key => ratios.push(clamp(f.shopProducts[key] / SHOP_PRODUCT_BASE_MAX, 0, 1)));
  if (!ratios.length) return 0;
  return (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100;
}

// 財政健全度: 週間支出に対して資金が何週分のバッファを持っているか(ランウェイ)を正規化する。
function clubRankFinancialScore() {
  const fin = state.club.finance;
  if (!fin || fin.expense <= 0) return state.club.money >= 0 ? 100 : 0;
  const runwayWeeks = state.club.money / fin.expense;
  return clamp(Math.round((runwayWeeks / CLUB_RANK_TARGET_RUNWAY_WEEKS) * 100), 0, 100);
}

// 育成輩出実績: 移籍させた人数・コーチ斡旋人数・トップ昇格人数の累積カウンタから算出する。
function clubRankDevelopmentScore() {
  const d = state.club.developmentStats;
  if (!d) return 0;
  return clamp(d.graduatesToTop * 6 + d.transfersOutCount * 8 + d.coachBrokerCount * 5, 0, 100);
}

function computeClubRank() {
  const top = clubRankTopScore();
  const lowerOrg = clubRankLowerOrgScore();
  const facility = clubRankFacilityScore();
  const financial = clubRankFinancialScore();
  const development = clubRankDevelopmentScore();
  const pct = clamp(
    top * CLUB_RANK_WEIGHTS.top +
    lowerOrg * CLUB_RANK_WEIGHTS.lowerOrg +
    facility * CLUB_RANK_WEIGHTS.facility +
    financial * CLUB_RANK_WEIGHTS.financial +
    development * CLUB_RANK_WEIGHTS.development
  , 0, 100);
  const score = clamp(Math.round(pct * 10), 0, 1000);
  const stage = clamp(Math.floor(score / 50), 0, CLUB_RANK_STAGES.length - 1);
  return { score, stage, label: CLUB_RANK_STAGES[stage].label, breakdown: { top, lowerOrg, facility, financial, development } };
}

// 施設レベル上限(facilityMaxLevel等)専用のショートカット。財政健全度(資金÷週間支出)を
// スコアに含めているため、施設をアップグレードして資金を使った直後は一時的にスコアが
// 下がり得る。ここでcomputeClubRank().stageをそのまま返すと、施設をレベルアップした
// 瞬間に(その施設を含む)全施設の上限が下がって見えるバグになるため、これまでに到達した
// 最高段階(state.club.peakRankStage)を記録し、その最大値を返すことで上限を単調増加にする。
function clubRankStage() {
  const stage = computeClubRank().stage;
  const peak = Math.max(stage, state.club.peakRankStage || 0);
  state.club.peakRankStage = peak;
  return peak;
}

// リーグ昇格には順位条件に加えてクラブランク段階の下限を課す(企画書2.2「大陸以上は
// 成績+クラブランクが必要」の反映)。「そのティアを抜けるにはクラブランクも同じ段階以上」
// という単純なランプにしておくと、リーグ段数が変わっても自動的に追随する。クラブランクは
// ティア数(10)の倍の20段階あるため、ティア番号を2倍してスコア換算での難易度を維持する。
const TIER_PROMOTION_MIN_RANK_STAGE = TIER_META.map((_, i) => i * 2);

function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function genClubName() {
  return `${choice(CLUB_PREFIXES)}・${choice(CLUB_SUFFIXES)}`;
}
function genPlayerName() {
  return `${choice(FIRST_NAMES)}・${choice(LAST_NAMES)}`;
}
function weightedPosition() {
  const r = Math.random();
  if (r < 0.10) return 'GK';
  if (r < 0.45) return 'DF';
  if (r < 0.80) return 'MF';
  return 'FW';
}

// ---------- ポジション枠(GK/DF/MF/FW) ----------
// トップチーム(26人)を基準に「GK3・DF8・MF9・FW6」という配分を目安比率として定義し、
// 保有人数上限(cap)が違うチーム(2軍以下・ユース・ジュニアユース・U-12)にも同じ比率を
// 適用して枠数を算出する。初期スカッド生成(posCounts)もこの比率と一致させている。
const POSITION_ORDER = ['GK', 'DF', 'MF', 'FW'];
const POSITION_QUOTA_RATIO = { GK: 3 / 26, DF: 8 / 26, MF: 9 / 26, FW: 6 / 26 };

// 指定した保有人数上限(cap)に対する、そのポジションの目安枠(最低1)。
function positionQuota(pos, cap) {
  return Math.max(1, Math.round(POSITION_QUOTA_RATIO[pos] * cap));
}

function positionQuotaAll(cap) {
  const q = {};
  POSITION_ORDER.forEach(pos => { q[pos] = positionQuota(pos, cap); });
  return q;
}

function positionCounts(players) {
  const c = { GK: 0, DF: 0, MF: 0, FW: 0 };
  players.forEach(p => { if (c[p.pos] != null) c[p.pos]++; });
  return c;
}

// 指定した選手集団の中で、そのポジションの枠がまだ空いているか。
function hasPositionRoom(players, pos, cap) {
  return positionCounts(players)[pos] < positionQuota(pos, cap);
}

// 枠に空きのあるポジションの中から、weightedPosition()と同じ比率の重みで1つ選ぶ。
// 全ポジションが枠一杯(スカッドがcap近くまで埋まっている等)の場合は素のweightedPosition()を返す。
function weightedPositionWithQuota(players, cap) {
  const open = POSITION_ORDER.filter(pos => hasPositionRoom(players, pos, cap));
  if (!open.length) return weightedPosition();
  let pos;
  do { pos = weightedPosition(); } while (!open.includes(pos));
  return pos;
}

// ポジションごとに「得意なパラメータ」をoverall近辺、「不得意なパラメータ」を大きく below にして生成する。
// 潜在能力(potential)はoverallに対してのみ設定し、各パラメータ個別の潜在値は持たせない
// (パラメータはoverallの成長・衰えに連動して同じ量だけ増減させることで一貫性を保つ)。
function generateAttributes(pos, overall) {
  const near = (center, spread) => clamp(Math.round(center + randInt(-spread, spread)), 1, ABILITY_CAP);
  // 非適性パラメータの基礎値。overallに応じてスケールさせ、低overall選手の非適性値が
  // 本職の値より高く見えてしまう(例: 総合力11のDFがGK24)ような不自然さを防ぐ。
  const off_ = () => clamp(Math.round(overall * 0.35) + randInt(-3, 3), 1, 40);
  switch (pos) {
    case 'GK':
      return {
        gk: near(overall, 6),
        def: near(overall - 15, 10),
        phy: near(overall - 10, 10),
        spd: off_(),
        off: off_(),
      };
    case 'DF':
      return {
        def: near(overall, 6),
        phy: near(overall - 8, 10),
        spd: near(overall - 15, 12),
        off: near(overall - 25, 12),
        gk: off_(),
      };
    case 'MF':
      return {
        off: near(overall - 5, 10),
        def: near(overall - 5, 10),
        spd: near(overall - 10, 12),
        phy: near(overall - 12, 10),
        gk: off_(),
      };
    case 'FW':
    default:
      return {
        off: near(overall, 6),
        spd: near(overall - 8, 10),
        phy: near(overall - 15, 10),
        def: near(overall - 30, 12),
        gk: off_(),
      };
  }
}

// 5パラメータ(off/def/gk/phy/spd)にoverallと同じ増減量を適用し、成長・衰えの前後で
// 選手ごとの「得意不得意の個性」の相対関係は保ったまま数値だけ動かす。
function applyAttributeDelta(p, delta) {
  ['off', 'def', 'gk', 'phy', 'spd'].forEach(key => {
    p[key] = clamp(p[key] + delta, 1, ABILITY_CAP);
  });
}

function createPlayer(pos, age, overall) {
  const potBonus = age <= 21 ? randInt(5, 22) : randInt(0, 6);
  const potential = clamp(overall + potBonus, overall, ABILITY_CAP);
  return { id: uid(), name: genPlayerName(), pos, age, overall, potential, condition: CONDITION_MAX, ...generateAttributes(pos, overall) };
}

// scoutRatio: 現在のティアのスカウト帯(5段階)の中でどこまで極めたか(0〜1)。
// ティアが上がるとscoutMaxLevelも伸びるため、昇格直後は一時的にratioが下がり、
// 「昇格したらスカウトも鍛え直す」という投資サイクルが生まれる。
// teamStr: 自チームの現在の実力(teamStrength()の値)。候補の総合値は主にこれを基準にする。
// スカウトレベルは「自チームより格上の掘り出し物」が出る確率と上げ幅を広げる役割に絞ることで、
// 昇格直後や弱小クラブでも身の丈に合った候補が中心になり、格上の選手は稀・かつ後述のプレミアム
// 価格($premiumMult$)で「頑張らないと買えない」存在になる。
function makeMarketPlayer(tierIdx, scoutRatio, teamStr) {
  const age = randInt(16, 29);
  // 大半の候補は自チームと同格〜やや下に集まる(下振れ2つのrandIntを足して山なりの分布にする)。
  let baseOverall = teamStr - randInt(0, 6) - randInt(0, 4) + randInt(0, 3 + Math.round(scoutRatio * 6));
  // まれに大当たり枠(自チームより明確に格上の候補)。出現確率・上げ幅はスカウトレベルに応じて伸びる。
  if (Math.random() < 0.08 + scoutRatio * 0.17) {
    baseOverall += randInt(6, 10 + Math.round(scoutRatio * 10));
  }
  // teamStr相対の値をそのまま使う(絶対値での頭打ちを撤廃)。ティアが上がってteamStrが
  // 伸びれば、移籍市場の候補レンジもそのまま一緒に伸びる。
  const overall = clamp(Math.round(baseOverall), 5, ABILITY_CAP);
  const pos = weightedPosition();
  const player = createPlayer(pos, age, overall);
  if (age <= 21) {
    // 照明(lighting)のLvぶん、若手候補の潜在能力の伸びしろに上乗せする。所有直後のLv1では
    // ごくわずかな差だが、クラブランクの上昇に伴ってLv上限が伸びていく(最大14)ため、
    // 施設投資を重ねるほど「新しく獲得する若手の質」がはっきり底上げされていく。
    const lightingBonus = state.club.facilities.grounds.top.lighting * 2;
    player.potential = clamp(applyPotentialGuardrail(player.overall, 'market', tierIdx, scoutRatio) + lightingBonus, player.overall, ABILITY_CAP);
  }
  const tierMult = TIER_PRICE_MULT[tierIdx];
  // 自チームより格上なほど価格が跳ね上がる(2乗で効かせて「少し格上」でも一段高く感じさせる)。
  const gap = Math.max(0, overall - teamStr);
  const premiumMult = 1 + gap * gap * 0.008;
  player.price = Math.round((player.overall * 8 + player.potential * 10) * tierMult * premiumMult * (0.85 + Math.random() * 0.3));
  return player;
}

// ---------- コンディション(疲労) ----------
// トップチームの選手は「出場した試合」に応じてコンディション(0〜100)を消耗し、出場しなかった
// 週に回復する。厚みのある26人スカッドを整えていれば出場選手を分散させて摩耗を抑えられるが、
// 主力任せの薄いスカッドでは同じ11人が消耗し続け、実効値が下限(70%)近くに落ち込みやすくなる。
// これにより「ベンチ入り18人までしか出場できない」という保有人数ルールに、リーグ戦・カップ戦
// 双方で意味を持たせる(層の厚さがそのまま強さの持続力になる)。
const CONDITION_MAX = 100;
const CONDITION_MATCH_COST = 15; // 1試合出場ごとの消耗
const CONDITION_RECOVERY_BASE = 15; // 出場しなかった週の回復量(プール施設Lvぶん加算)
const CONDITION_MIN_FACTOR = 0.7; // コンディション0のときの実効値の下限(70%)。0にはしない

function effectiveOverall(p) {
  const cond = clamp(p.condition, 0, CONDITION_MAX);
  return p.overall * (CONDITION_MIN_FACTOR + (1 - CONDITION_MIN_FACTOR) * cond / CONDITION_MAX);
}

// コンディションを踏まえた出場11人と、その実効総合力の平均を返す(消耗はさせない=閲覧用)。
function pickMatchXI(players) {
  if (!players.length) return { xi: [], avgEff: 30 };
  // 出場停止中(レッドカードの罰則)の選手は選出対象から外す。全員出場停止など極端なケースの
  // 保険として、対象がいなければ通常どおり全選手から選ぶ。
  const eligible = players.filter(p => !(p.suspendedMatches > 0));
  const pool = eligible.length ? eligible : players;
  const sorted = [...pool].sort((a, b) => effectiveOverall(b) - effectiveOverall(a));
  const xi = sorted.slice(0, Math.min(11, sorted.length));
  const avgEff = xi.reduce((s, p) => s + effectiveOverall(p), 0) / xi.length;
  return { xi, avgEff };
}

// スタメン(pickMatchXI)と同じ選出基準で、ベンチ入り枠を含めた18人を返す(閲覧用)。
function pickMatchdaySquad18(players) {
  if (!players.length) return [];
  const eligible = players.filter(p => !(p.suspendedMatches > 0));
  const pool = eligible.length ? eligible : players;
  const sorted = [...pool].sort((a, b) => effectiveOverall(b) - effectiveOverall(a));
  return sorted.slice(0, Math.min(18, sorted.length));
}

// 週内(1節)でトップチームが出場した選手のidを集める(リーグ戦・カップ戦を問わず追加していく)。
let weekPlayedIds = new Set();

// トップチームの実効戦力: コンディション込みの出場11人の総合力に、監督・アシスタントの
// 戦術ボーナスを上乗せする。閲覧・組み合わせ抽選のシード用(選手を消耗させない)。
function myTopMatchStrength() {
  return pickMatchXI(state.club.players).avgEff + coachMatchBonus('top');
}

// 直近にplayMyTopMatch()が選出した出場11人。試合直後にその場でgenerateTopMatchEvents()へ
// 渡して実況イベント(得点者・カード・怪我)を組み立てるための一時参照(永続化しない)。
let lastPlayedXI = [];

// 実際に1試合を消化する瞬間にだけ呼ぶ: 出場11人のコンディションを消耗させ、
// その週にプレーした選手として記録する(回復はapplyWeeklyConditionRecovery()でまとめて行う)。
function playMyTopMatch() {
  const { xi, avgEff } = pickMatchXI(state.club.players);
  xi.forEach(p => {
    p.condition = clamp(p.condition - CONDITION_MATCH_COST, 0, CONDITION_MAX);
    weekPlayedIds.add(p.id);
    const st = state.club.seasonStats[p.id] || (state.club.seasonStats[p.id] = { goals: 0, yellow: 0, red: 0, injuries: 0, apps: 0, ratingSum: 0 });
    st.apps++;
  });
  lastPlayedXI = xi;
  return avgEff + coachMatchBonus('top');
}

// その週(1節)に一度も出場しなかった選手を回復させる。プール施設のレベルぶん回復量が増える。
function applyWeeklyConditionRecovery() {
  const recovery = CONDITION_RECOVERY_BASE + state.club.facilities.grounds.top.pool * 2;
  state.club.players.forEach(p => {
    if (!weekPlayedIds.has(p.id)) {
      p.condition = clamp(p.condition + recovery, 0, CONDITION_MAX);
      if (p.suspendedMatches > 0) p.suspendedMatches--;
    }
  });
}

function teamStrength(players) {
  if (!players.length) return 30;
  const sorted = [...players].sort((a, b) => b.overall - a.overall);
  const top = sorted.slice(0, Math.min(11, sorted.length));
  return top.reduce((s, p) => s + p.overall, 0) / top.length;
}

function simulateMatch(strA, strB) {
  const diff = (strA - strB) / 8;
  const expA = clamp(1.35 + diff * 0.55, 0.15, 4.2);
  const expB = clamp(1.35 - diff * 0.55, 0.15, 4.2);
  return [poisson(expA), poisson(expB)];
}

// ---------- トップチーム試合の実況イベント(得点者・カード・怪我) ----------
// 最終スコア自体はsimulateMatch()のままにして収支・順位表への影響を変えず、
// 「誰が/何分に」を後付けで割り振ることで試合経過を実況風に見せる。

function turfLevel() {
  return state.club.facilities.grounds.top.turf;
}

// 相手クラブは個別選手を保有しないため、実況表示用に架空のイレブンをその場で生成する
// (永続化はせず、この1試合の実況の中だけで使い捨てる)。
function genOpponentXI() {
  return Array.from({ length: 11 }, () => {
    const pos = weightedPosition();
    const base = pos === 'FW' ? 55 : pos === 'MF' ? 45 : pos === 'DF' ? 22 : 8;
    return {
      name: genPlayerName(), pos,
      off: clamp(base + randInt(-15, 15), 1, 80),
      def: clamp((70 - base) + randInt(-15, 15), 1, 80),
    };
  });
}

function weightedPick(items, weightFn) {
  const weights = items.map(item => Math.max(0.01, weightFn(item)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function randomEventMinute() {
  if (Math.random() < 0.06) return 90 + randInt(1, 4); // アディショナルタイム
  return randInt(1, 90);
}

function randomCardCount() {
  const r = Math.random();
  if (r < 0.15) return 0;
  if (r < 0.45) return 1;
  if (r < 0.70) return 2;
  if (r < 0.87) return 3;
  if (r < 0.96) return 4;
  return 5;
}

const INJURY_CONDITION_PENALTY = { mild: 12, moderate: 28, severe: 45 };
const INJURY_LABEL = { mild: '軽傷', moderate: '負傷', severe: '重傷' };

// xi: 自クラブの出場11人(playMyTopMatch()が返したものをそのまま渡す)。
// myGoals/oppGoals: simulateMatch()で既に決まった最終スコア(このスコアは変更しない)。
// 戻り値はminute昇順に並んだイベント配列。team==='me'のイベントにはplayerId(選手ID)が入る。
function generateTopMatchEvents(xi, myGoals, oppGoals, oppName, turfLv) {
  const oppXI = genOpponentXI();
  const events = [];
  const cardCountByKey = {};

  for (let i = 0; i < myGoals; i++) {
    const scorer = weightedPick(xi, p => p.off + 5);
    events.push({ minute: randomEventMinute(), type: 'goal', team: 'me', playerId: scorer.id, name: scorer.name, pos: scorer.pos });
  }
  for (let i = 0; i < oppGoals; i++) {
    const scorer = weightedPick(oppXI, p => p.off + 5);
    events.push({ minute: randomEventMinute(), type: 'goal', team: 'opp', name: scorer.name, pos: scorer.pos });
  }

  const cardCount = randomCardCount();
  for (let i = 0; i < cardCount; i++) {
    const team = Math.random() < 0.5 ? 'me' : 'opp';
    const pool = team === 'me' ? xi : oppXI;
    if (!pool.length) continue;
    const target = weightedPick(pool, p => (p.def || 10) + 5);
    const key = team + ':' + (team === 'me' ? target.id : pool.indexOf(target));
    cardCountByKey[key] = (cardCountByKey[key] || 0) + 1;
    const isSecondYellow = cardCountByKey[key] === 2;
    const isStraightRed = !isSecondYellow && Math.random() < 0.08;
    const type = (isSecondYellow || isStraightRed) ? 'red' : 'yellow';
    events.push({
      minute: randomEventMinute(), type, team,
      playerId: team === 'me' ? target.id : null,
      name: target.name, pos: target.pos,
      detail: isSecondYellow ? '2枚目の警告' : undefined,
    });
  }

  // 芝(グラウンド施設)のレベルが高いほど怪我をしにくくなる(施設タブの説明どおりの効果)。
  const injuryChance = clamp(0.12 - turfLv * 0.012, 0.03, 0.12);
  if (Math.random() < injuryChance) {
    const team = Math.random() < 0.5 ? 'me' : 'opp';
    const pool = team === 'me' ? xi : oppXI;
    if (pool.length) {
      const target = choice(pool);
      const severityRoll = Math.random();
      const severity = severityRoll < 0.5 ? 'mild' : severityRoll < 0.85 ? 'moderate' : 'severe';
      events.push({
        minute: randomEventMinute(), type: 'injury', team,
        playerId: team === 'me' ? target.id : null,
        name: target.name, pos: target.pos, severity,
      });
    }
  }

  events.sort((a, b) => a.minute - b.minute);
  return events;
}

// 自クラブの選手が関わるイベントだけ、シーズンスタッツ・コンディション・出場停止に反映する
// (相手選手のイベントは実況上の演出のみで、ゲーム内の状態には影響しない)。
// xi/resultを渡すと、出場した11人ぶんの個人採点(基準6.5点+得点・カード・勝敗による加減、
// 5.0〜10.0にクランプ)をシーズン累計(ratingSum)にも積み上げ、平均個人スコアの元データにする。
function applyTopMatchEventConsequences(events, xi, result) {
  const stats = state.club.seasonStats;
  const ensureStat = (id) => stats[id] || (stats[id] = { goals: 0, yellow: 0, red: 0, injuries: 0, apps: 0, ratingSum: 0 });

  if (xi && xi.length) {
    const resultBonus = result === 'win' ? 0.3 : result === 'lose' ? -0.3 : 0;
    const ratings = {};
    xi.forEach(p => { ratings[p.id] = 6.5 + resultBonus; });
    events.forEach(ev => {
      if (ev.team !== 'me' || !ev.playerId || !(ev.playerId in ratings)) return;
      if (ev.type === 'goal') ratings[ev.playerId] += 1.0;
      else if (ev.type === 'yellow') ratings[ev.playerId] -= 0.3;
      else if (ev.type === 'red') ratings[ev.playerId] -= 1.0;
      else if (ev.type === 'injury') ratings[ev.playerId] -= 0.2;
    });
    xi.forEach(p => {
      const st = ensureStat(p.id);
      st.ratingSum = (st.ratingSum || 0) + clamp(ratings[p.id], 5.0, 10.0);
    });
  }

  events.forEach(ev => {
    if (ev.team !== 'me' || !ev.playerId) return;
    const st = ensureStat(ev.playerId);
    if (ev.type === 'goal') st.goals++;
    else if (ev.type === 'yellow') st.yellow++;
    else if (ev.type === 'red') {
      st.red++;
      const p = state.club.players.find(pl => pl.id === ev.playerId);
      if (p) p.suspendedMatches = (p.suspendedMatches || 0) + 1;
    } else if (ev.type === 'injury') {
      st.injuries++;
      const p = state.club.players.find(pl => pl.id === ev.playerId);
      if (p) p.condition = clamp(p.condition - INJURY_CONDITION_PENALTY[ev.severity], 0, CONDITION_MAX);
    }
  });
}

function generateRoundRobin(teamIds) {
  const ids = teamIds.slice();
  const n = ids.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      let home = ids[i], away = ids[n - 1 - i];
      if (r % 2 === 1) { const tmp = home; home = away; away = tmp; }
      pairs.push([home, away]);
    }
    rounds.push(pairs);
    const fixed = ids[0];
    const rest = ids.slice(1);
    rest.unshift(rest.pop());
    ids.splice(0, n, fixed, ...rest);
  }
  return rounds;
}

// ホーム&アウェーの完全総当たり: 1stレグ(n-1節)に続けて、ホーム/アウェーを入れ替えた
// 2ndレグ(n-1節)を追加する。n=20なら 19*2=38節。
function generateDoubleRoundRobin(teamIds) {
  const firstLeg = generateRoundRobin(teamIds);
  const secondLeg = firstLeg.map(round => round.map(([home, away]) => [away, home]));
  return [...firstLeg, ...secondLeg];
}

// ---------- 状態 ----------

// セーブデータは3スロット持てる(スロットごとに独立したキーで永続化)。
const SAVE_SLOT_COUNT = 3;
const SAVE_KEY_PREFIX = 'wpe11_mvp_save_slot_';
const CURRENT_SLOT_KEY = 'wpe11_mvp_current_slot';
const LEGACY_SAVE_KEY = 'wpe11_mvp_save_v1'; // 旧バージョン(単一スロット)からの引き継ぎ用

let currentSlot = null; // 1〜SAVE_SLOT_COUNT。タイトル画面でスロットを選ぶまではnull。

const state = {
  club: null,
  season: 1,
  phase: 'season',
  teams: {},
  standings: {},
  fixtures: [],
  currentRound: 0,
  market: [],
  log: [],
  lastFinalStandings: null,
  lastSeasonSummary: null,
  seasonEndReview: null,
  leagueCup: null,
  worldCup: null,
  continentalCup: null,
  worldClubCup: null,
  champCup: null,
  topMatchLog: [],
  pendingDecision: null,   // 週次意思決定(企画書12.6): 未処理の決断があればモーダルを開く
  lastDecisionRound: -99,  // 直近に決断を出した節(連発を防ぐクールダウン用)
  savedAt: null,
};

function slotKey(slot) { return SAVE_KEY_PREFIX + slot; }

// 旧バージョン(セーブスロット導入前)のデータが残っていて、かつスロット1がまだ空の場合、
// そのままスロット1として引き継ぐ(プレイヤーの過去の進行状況を失わせないため)。
function migrateLegacySave() {
  try {
    if (localStorage.getItem(slotKey(1))) return;
    const raw = localStorage.getItem(LEGACY_SAVE_KEY);
    if (raw) localStorage.setItem(slotKey(1), raw);
  } catch (e) { /* ignore */ }
}

function save() {
  if (!currentSlot) return;
  try {
    state.savedAt = Date.now();
    localStorage.setItem(slotKey(currentSlot), JSON.stringify(state));
  } catch (e) { /* ignore */ }
}

// 指定スロットの生データを返す(読み込むだけで現在のstateには反映しない。
// タイトル画面でのサマリー表示や、スロット切替の判定に使う)。
function loadSlotData(slot) {
  try {
    const raw = localStorage.getItem(slotKey(slot));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// 指定スロットのデータを現在のstateへ読み込む。成功したらcurrentSlotも更新する。
function loadSlotIntoState(slot) {
  const data = loadSlotData(slot);
  if (!data || !data.club) return false;
  Object.assign(state, data);
  currentSlot = slot;
  try { localStorage.setItem(CURRENT_SLOT_KEY, String(slot)); } catch (e) { /* ignore */ }
  return true;
}

function deleteSlotData(slot) {
  try { localStorage.removeItem(slotKey(slot)); } catch (e) { /* ignore */ }
}

// タイトル画面のスロットカード表示用の要約情報。データが無ければnull。
function slotSummary(slot) {
  const data = loadSlotData(slot);
  if (!data || !data.club) return null;
  const tier = TIERS[data.club.tier];
  return {
    clubName: data.club.name,
    tierName: tier ? tier.name : '-',
    season: data.season,
    money: data.club.money,
    savedAt: data.savedAt,
  };
}

// 旧バージョンのセーブ(training/medical のみで grounds/youthTeams/academy が無いもの)を
// 現行のデータ構造に合わせて補完する。
function migrateClub(club) {
  if (!club.youthTeams) {
    club.youthTeams = {
      reserve: false, youth: false, youthReserve: false,
      juniorYouth: false, juniorYouthReserve: false,
      u12_1: false, u12_2: false, u12_3: false, u12_4: false, u12_5: false,
      reserve3: false, reserve4: false, reserve5: false,
    };
  }
  // 旧バージョン(3〜5軍導入前)のセーブを補完する。
  if (club.youthTeams.reserve3 === undefined) {
    club.youthTeams.reserve3 = false;
    club.youthTeams.reserve4 = false;
    club.youthTeams.reserve5 = false;
  }
  if (!club.facilities.grounds) {
    const oldTraining = club.facilities.training || 1;
    const oldMedical = club.facilities.medical || 1;
    club.facilities.grounds = {
      top: { pitch: oldTraining, turf: 1, lighting: 1, pool: 1, medical: oldMedical },
      reserve: zeroGroundBundle(),
      reserve3: zeroGroundBundle(),
      reserve4: zeroGroundBundle(),
      reserve5: zeroGroundBundle(),
      youth: zeroGroundBundle(),
      juniorYouth: zeroGroundBundle(),
      u12: zeroGroundBundle(),
    };
    delete club.facilities.training;
    delete club.facilities.medical;
  }
  // 旧バージョン(3〜5軍で練習場を共用していたセーブ)を個別の練習場に分割する。
  // 既存の投資が消えないよう、共用だった分を3軍の練習場にそのまま引き継ぐ(4軍/5軍は新規)。
  if (club.facilities.grounds.reserveLower && !club.facilities.grounds.reserve3) {
    club.facilities.grounds.reserve3 = club.facilities.grounds.reserveLower;
    club.facilities.grounds.reserve4 = zeroGroundBundle();
    club.facilities.grounds.reserve5 = zeroGroundBundle();
    delete club.facilities.grounds.reserveLower;
  }
  if (!club.facilities.grounds.reserve3) club.facilities.grounds.reserve3 = zeroGroundBundle();
  if (!club.facilities.grounds.reserve4) club.facilities.grounds.reserve4 = zeroGroundBundle();
  if (!club.facilities.grounds.reserve5) club.facilities.grounds.reserve5 = zeroGroundBundle();
  if (!club.facilities.stadiums) {
    // 旧バージョン(単一レベルの stadium/stadium2)を、メインスタンド1項目に引き継いで移行する。
    const oldStadium = club.facilities.stadium != null ? club.facilities.stadium : 1;
    const oldStadium2 = club.facilities.stadium2 != null ? club.facilities.stadium2 : 0;
    club.facilities.stadiums = {
      top: { mainStand: oldStadium, subStand: 0, vipRoom: 0, beer: 0, food: 0 },
      reserve: { mainStand: oldStadium2, subStand: 0, vipRoom: 0, beer: 0, food: 0 },
      reserveLower: zeroStadiumBundle(),
    };
    delete club.facilities.stadium;
    delete club.facilities.stadium2;
  }
  if (!club.facilities.stadiums.reserveLower) club.facilities.stadiums.reserveLower = zeroStadiumBundle();
  if (club.facilities.youthStadium === undefined) club.facilities.youthStadium = 0;
  if (club.facilities.scoutYouth === undefined) club.facilities.scoutYouth = 0;
  if (club.facilities.scoutJuniorYouth === undefined) club.facilities.scoutJuniorYouth = 0;
  if (club.facilities.scoutU12 === undefined) club.facilities.scoutU12 = 0;
  // 旧バージョン(ショップ施設導入前)のセーブを補完する。
  if (club.facilities.shopRegional === undefined) club.facilities.shopRegional = 0;
  if (club.facilities.shopOnline === undefined) club.facilities.shopOnline = 0;
  if (club.facilities.shopOverseas === undefined) club.facilities.shopOverseas = 0;
  if (club.facilities.shopLicense === undefined) club.facilities.shopLicense = 0;
  if (!club.facilities.shopStadium) club.facilities.shopStadium = zeroShopStadiumBundle();
  if (!club.facilities.shopGround) club.facilities.shopGround = zeroShopGroundBundle();
  if (!club.facilities.shopProducts) club.facilities.shopProducts = zeroShopProductBundle();
  SHOP_PRODUCT_KEYS.forEach(key => { if (club.facilities.shopProducts[key] === undefined) club.facilities.shopProducts[key] = 0; });
  if (!club.academy) club.academy = { prospects: [] };
  if (!club.academyAutopilot) club.academyAutopilot = { u12: false, juniorYouth: false, youth: false };
  if (!club.affiliates) club.affiliates = [];
  if (!club.sponsors) {
    // 旧バージョンのセーブにはスポンサー枠が無いため、小さな地元スポンサー1枠を新規契約させて補完する。
    // 残りの枠は現在の評判値に応じて「スポンサー」タブから順次解放・契約できる。
    club.sponsors = { general: Array(SPONSOR_GENERAL_SLOTS).fill(null), youth: null, juniorYouth: null, u12: null };
    autoSignInitialSponsor();
  }
  // 旧バージョン(全体スポンサーが5枠だったセーブ)を新しい枠数まで拡張する。
  while (club.sponsors.general.length < SPONSOR_GENERAL_SLOTS) club.sponsors.general.push(null);
  // 旧バージョン(格・成長ボーナス導入前)の契約済みスポンサーに tierIdx・effect を補完する。
  const ensureSponsorEffect = (slot) => {
    if (!slot) return;
    if (slot.tierIdx === undefined) slot.tierIdx = 0;
    if (!slot.effect) slot.effect = makeSponsorEffect(slot.tierIdx, slot.powerMult);
  };
  club.sponsors.general.forEach(ensureSponsorEffect);
  ['youth', 'juniorYouth', 'u12'].forEach(cat => ensureSponsorEffect(club.sponsors[cat]));
  if (!club.coaches) club.coaches = {};
  ensureCoachSet('top');
  YOUTH_TEAM_ORDER.forEach(key => { if (club.youthTeams[key]) ensureCoachSet(key); });
  // 旧バージョンのセーブ(5パラメータが無い選手)を補完する。
  const fillAttributes = (p) => {
    if (p.off === undefined) Object.assign(p, generateAttributes(p.pos, p.overall));
  };
  club.players.forEach(fillAttributes);
  (club.academy.prospects || []).forEach(fillAttributes);
  // 旧バージョン(コンディション導入前)のセーブに、トップチーム所属選手のコンディションを補完する。
  club.players.forEach(p => { if (p.condition === undefined) p.condition = CONDITION_MAX; });
  if (!club.academyLeagues) {
    club.academyLeagues = {
      reserve: null, youth: null, youthReserve: null,
      juniorYouth: null, juniorYouthReserve: null,
      u12_1: null, u12_2: null, u12_3: null, u12_4: null, u12_5: null,
      reserve3: null, reserve4: null, reserve5: null,
    };
  }
  if (club.academyLeagues.reserve3 === undefined) {
    club.academyLeagues.reserve3 = null;
    club.academyLeagues.reserve4 = null;
    club.academyLeagues.reserve5 = null;
  }
  // 旧バージョン(下部組織カップ導入前)のセーブを補完する。
  if (!club.academyCups) club.academyCups = {};
  // 旧バージョン(2〜5軍の11人未満参戦ガード導入前)のセーブを補完する。
  if (!club.reserveRejoinTier) {
    club.reserveRejoinTier = { reserve: 0, reserve3: 0, reserve4: 0, reserve5: 0 };
  }
  // 旧バージョン(トップ〜5軍の表共有導入前)のセーブを補完する。2〜5軍は今後
  // academyLeagues[key]を使わず、reserveTier/reserveActiveで参戦状態を管理する。
  if (!club.reserveTier) club.reserveTier = { reserve: 0, reserve3: 0, reserve4: 0, reserve5: 0 };
  if (!club.reserveActive) club.reserveActive = { reserve: false, reserve3: false, reserve4: false, reserve5: false };
  if (!club.reserveMatchLog) club.reserveMatchLog = { reserve: [], reserve3: [], reserve4: [], reserve5: [] };
  if (!club.adultLeagues) club.adultLeagues = {};
  // 旧仕様(2〜5軍が独自クロックで進行する独立リーグ)のデータが残っている場合、トップの
  // クロックと噛み合わない可能性があるため、進行中の対戦データは引き継がずティア(段階)だけ
  // 引き継いで参戦待機に戻す(11人組めていれば次シーズン開始時に同じティアから再参戦する)。
  RESERVE_LEVEL_KEYS.forEach(key => {
    // academyLeagues[key]が残っているのは、この機能追加より前のセーブだけ(新形式では
    // 常にnullのまま)。そのときだけティアを引き継いで参戦待機に戻す。既に新形式のセーブ
    // (reserveActive/reserveTierで管理済み)はここでは一切触らない。
    const oldLeague = club.academyLeagues[key];
    if (oldLeague) {
      club.reserveTier[key] = oldLeague.tier;
      club.reserveRejoinTier[key] = oldLeague.tier;
      club.academyLeagues[key] = null;
      club.reserveActive[key] = false;
    }
    // 旧形式(リーグの顔ぶれを流用)のカップはリーグと構造が変わったため破棄する
    // (次シーズン開始時、参戦していれば自動で新形式のカップが組み直される)。
    if (club.academyCups[key] && club.academyCups[key].tierIdx === undefined) {
      delete club.academyCups[key];
    }
  });
  // 旧バージョン(U-12が1つの統合リーグに合流する仕様だったセーブ)の後始末。
  // 統合リーグは廃止したため、各所持チームを1段階目から個別リーグとして再スタートする。
  if (club.u12Merged) {
    delete club.academyLeagues.u12;
    delete club.u12Merged;
  }
  // 旧バージョン(ユース/ジュニアユース本体への11人未満参戦ガード導入前)のセーブ向けの
  // 後始末。0人(または11人未満)のまま参戦してしまっているリーグは、今シーズンの参戦を
  // 中断する(updateReserveLeagueParticipation()の中断分岐と同じ扱い)。
  ['youth', 'juniorYouth'].forEach(key => {
    const league = club.academyLeagues[key];
    if (league && !tieredTeamCanField(key)) {
      club.reserveRejoinTier[key] = Math.max(league.tier - 1, 0);
      club.academyLeagues[key] = null;
    }
  });
  // 既に所持しているユース/ジュニアユース/U-12(独自クロックを持つ旧エンジン側)で、まだ
  // リーグが組まれていないもの(この機能追加前のセーブデータ、または上記の統合リーグ廃止に
  // よる再スタート対象)は、現時点から新規に1段階目でリーグを開始する。2〜5軍は上記の
  // reserveTier/reserveActive経由で扱うためここでは対象外(次シーズン開始時に判定される)。
  YOUTH_TEAM_ORDER.forEach(key => {
    if (RESERVE_LEVEL_KEYS.includes(key)) return;
    if (!club.youthTeams[key] || club.academyLeagues[key]) return;
    if (TIER_GATED_KEYS.includes(key) && !tieredTeamCanField(key)) return;
    startAcademyLeagueSeason(key, 0);
  });
  // 上記より前から進行中だったユース/ジュニアユース/U-12リーグ(カップ導入前のセーブ)には、
  // まだカップが無いのでここで組み直しておく。
  Object.keys(club.academyLeagues).forEach(key => {
    const league = club.academyLeagues[key];
    if (league && !club.academyCups[key]) initAcademyCup(key, league.tier);
  });
  // state.teams/standings/fixturesとclub.adultLeagues[club.tier]は本来同じデータへの
  // 参照(別名)だが、セーブのJSON化/復元でそれぞれ別オブジェクトとして複製されてしまう。
  // adultLeagues側を正としてstate側を張り直す(2〜5軍が同居しているセーブでもmemberKeysが
  // 正しく保たれる)。adultLeagues側が無い(この機能追加より前のセーブ)場合のみ、
  // 既存のstate.teams等からトップ単独のエントリを合成する。
  if (club.adultLeagues[club.tier]) {
    state.teams = club.adultLeagues[club.tier].teams;
    state.standings = club.adultLeagues[club.tier].standings;
    state.fixtures = club.adultLeagues[club.tier].fixtures;
  } else if (state.teams) {
    club.adultLeagues[club.tier] = {
      tier: club.tier, memberKeys: ['top'], teams: state.teams, standings: state.standings, fixtures: state.fixtures,
    };
  }
  // 旧バージョン(クラブランク精緻化前)のセーブに、財政健全度・育成輩出実績の
  // 累積値を補完する。
  if (!club.finance) club.finance = { income: 0, expense: 0 };
  if (!club.developmentStats) club.developmentStats = { graduatesToTop: 0, transfersOutCount: 0, coachBrokerCount: 0 };
  // 旧バージョン(クラブ記録・マイルストーン導入前)のセーブを補完する(企画書12.4)。
  if (!club.records) club.records = initClubRecords();
  else {
    const base = initClubRecords();
    for (const k in base) if (club.records[k] === undefined) club.records[k] = base[k];
    if (!club.records.bests) club.records.bests = base.bests;
    for (const k in base.bests) if (club.records.bests[k] === undefined) club.records.bests[k] = base.bests[k];
  }
  // 旧バージョン(試合実況・シーズンスタッツ導入前)のセーブを補完する。
  if (!club.seasonStats) club.seasonStats = {};
  // 旧バージョン(施設上限の単調増加化前)のセーブを補完する。0から始めても次回の
  // clubRankStage()呼び出し時点の段階まですぐ追いつくため、既存プレイの不利益はない。
  if (club.peakRankStage === undefined) club.peakRankStage = 0;
  // 旧バージョン(評判値・クラブランクスコアの上限が100だったセーブ)を1000スケールに
  // 一度だけ移行する。段階(peakRankStage)はクラブランクが10→20段階に細分化された分だけ
  // 2倍しておかないと、施設レベル上限が移行直後に下がって見えてしまう。評判値は現在の
  // ティアのreputationCapForTier()を超えないようにも合わせて丸め込む(そうしないと、
  // 旧セーブの評判値をそのまま10倍しただけでは所属ティアに対して不自然に高い値になりうる)。
  if (!club.repScaledTo1000) {
    club.reputation = clamp(Math.round(club.reputation * 10), 0, reputationCapForTier(club.tier));
    club.peakRankStage = clamp(club.peakRankStage * 2, 0, CLUB_RANK_STAGES.length - 1);
    club.repScaledTo1000 = true;
  }
  // 旧バージョン(評判値の伸びが所属ティアと無関係だったセーブ)を、reputationCapForTier()の
  // 上限に合わせて一度だけ丸め込む。すでに解放済みの施設レベル上限(peakRankStage)は
  // そのまま維持し、評判値・クラブランクスコアの表示だけを所属ティアに見合った値に是正する。
  if (!club.reputationTierCapApplied) {
    club.reputation = clamp(club.reputation, 0, reputationCapForTier(club.tier));
    club.reputationTierCapApplied = true;
  }
  Object.values(club.academyLeagues).forEach(league => {
    if (league && !league.myMatchLog) league.myMatchLog = [];
  });
  // クラブ記録・マイルストーン(企画書12.4): 既存セーブは、現時点の到達内容を「基準値」として
  // 静かに既達扱いにする(過去ぶんの恒久ボーナスは付けず、ここから先の前進だけを報酬対象にする)。
  if (!club.records.seeded) {
    seedMilestonesBaseline();
    club.records.seeded = true;
  }
}

function addLog(text, type = '') {
  state.log.push({ text, type });
  if (state.log.length > 200) state.log.shift();
}

// ---------- ゲームフロー ----------

function newGame() {
  const club = {
    name: genClubName(),
    money: 800,
    tier: 0,
    reputation: 20,
    facilities: {
      scout: 1, youthStadium: 0,
      scoutYouth: 0, scoutJuniorYouth: 0, scoutU12: 0,
      shopRegional: 0, shopOnline: 0, shopOverseas: 0, shopLicense: 0,
      stadiums: {
        top: { mainStand: 1, subStand: 0, vipRoom: 0, beer: 0, food: 0 },
        reserve: zeroStadiumBundle(),
        reserveLower: zeroStadiumBundle(),
      },
      grounds: {
        top: fullGroundBundle(),
        reserve: zeroGroundBundle(),
        reserve3: zeroGroundBundle(),
        reserve4: zeroGroundBundle(),
        reserve5: zeroGroundBundle(),
        youth: zeroGroundBundle(),
        juniorYouth: zeroGroundBundle(),
        u12: zeroGroundBundle(),
      },
      shopStadium: zeroShopStadiumBundle(),
      shopGround: zeroShopGroundBundle(),
      shopProducts: zeroShopProductBundle(),
    },
    youthTeams: {
      reserve: false, youth: false, youthReserve: false,
      juniorYouth: false, juniorYouthReserve: false,
      u12_1: false, u12_2: false, u12_3: false, u12_4: false, u12_5: false,
      reserve3: false, reserve4: false, reserve5: false,
    },
    academy: { prospects: [] },
    // 企画書12.6(委任): カテゴリごとに「候補が出るたび自動でスカウトする」を任せられる。
    // 既定はOFF(オーナーが自分で選ぶ)。無償のスカウト候補にのみ作用する。
    academyAutopilot: { u12: false, juniorYouth: false, youth: false },
    academyLeagues: {
      reserve: null, youth: null, youthReserve: null,
      juniorYouth: null, juniorYouthReserve: null,
      u12_1: null, u12_2: null, u12_3: null, u12_4: null, u12_5: null,
      reserve3: null, reserve4: null, reserve5: null,
    },
    academyCups: {},
    // 2〜5軍はトップと表を共有しうるため、academyLeagues[key]では持たず、
    // 「今どのティアにいるか(reserveTier)」「今シーズン参戦しているか(reserveActive)」を
    // 個別に持つ(buildAdultLeagues参照)。
    reserveTier: { reserve: 0, reserve3: 0, reserve4: 0, reserve5: 0 },
    reserveActive: { reserve: false, reserve3: false, reserve4: false, reserve5: false },
    reserveMatchLog: { reserve: [], reserve3: [], reserve4: [], reserve5: [] },
    adultLeagues: {},
    reserveRejoinTier: { reserve: 0, reserve3: 0, reserve4: 0, reserve5: 0 },
    affiliates: [],
    sponsors: {
      general: Array(SPONSOR_GENERAL_SLOTS).fill(null),
      youth: null, juniorYouth: null, u12: null,
    },
    players: [],
    coaches: {},
    finance: { income: 0, expense: 0 },
    developmentStats: { graduatesToTop: 0, transfersOutCount: 0, coachBrokerCount: 0 },
    seasonStats: {},
    records: initClubRecords(),
    peakRankStage: 0,
    repScaledTo1000: true,
    reputationTierCapApplied: true,
  };
  // tier0のAIクラブの戦力を先に決めておく(AI群の戦力は据え置き)。自クラブの初期総合力は
  // チーム戦力の初期値として固定した15からスカッドを組む。
  const aiStrengths = buildAiStrengths(TIER_BASELINE[0], TEAM_COUNT - 1, TIER_HALF_WIDTH[0]);
  const targetStrength = 15;

  // トップ11人分は目標値の近辺(振れ幅を絞って安定させる)、残り7人(控え)はそれより
  // 明確に低くして、teamStrength()(上位11人平均)が目標値にきちんと収束するようにする。
  const overalls = [
    ...Array.from({ length: 11 }, () => clamp(Math.round(targetStrength) + randInt(-1, 1), 1, ABILITY_CAP)),
    ...Array.from({ length: 7 }, () => clamp(Math.round(targetStrength) - 12 + randInt(-4, 4), 1, ABILITY_CAP)),
  ];
  for (let i = overalls.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [overalls[i], overalls[j]] = [overalls[j], overalls[i]];
  }

  const posCounts = [['GK', 2], ['DF', 6], ['MF', 6], ['FW', 4]];
  let overallIdx = 0;
  posCounts.forEach(([pos, count]) => {
    for (let i = 0; i < count; i++) {
      club.players.push(createPlayer(pos, randInt(18, 30), overalls[overallIdx]));
      overallIdx++;
    }
  });
  state.club = club;
  ensureCoachSet('top');
  state.season = 1;
  state.market = [];
  state.affiliateCandidates = generateAffiliateCandidates();
  state.affiliateRosters = {};
  state.sponsorCandidates = { general: [], youth: [], juniorYouth: [], u12: [] };
  state.academyCandidates = { u12: [], juniorYouth: [], youth: [] };
  autoSignInitialSponsor();
  state.log = [];
  state.lastFinalStandings = null;
  state.lastSeasonSummary = null;
  addLog(`${club.name} のオーナーに就任。地域アマチュアリーグでの挑戦が始まります。`, 'gold');
  addLog(`この世界には、下部年代からトップまで一貫した強豪クラブが3つ存在します: ${RIVAL_CLUBS.map(r => r.name).join('、')}。特に${RIVAL_CLUBS[RIVAL_CLUBS.length - 1].name}は同じ年代で早い段階から出会うはずです。追い抜いていきましょう。`, 'gold');
  startSeason(0, aiStrengths);
  seedMilestonesBaseline();
  state.club.records.seeded = true;
  save();
}

// count クラブに戦力差をつける: baseline を中心に -halfWidth〜+halfWidth の帯域を均等に割り振り、
// どのクラブがどの帯域になるかはシャッフルしてランダム化した上で、さらに小さな乱数ノイズを足す。
// これにより毎シーズン「優勝候補の強豪が数クラブ」「中位が厚く」「降格候補の弱小クラブが数クラブ」
// という現実のリーグらしい戦力ピラミッドが自動的にできる。halfWidthを省略した場合は既定値
// (AI_BAND_HALF_WIDTH)を使うが、所属ティアが決まっている呼び出し元は必ずTIER_HALF_WIDTH[tierIdx]
// を渡し、「下位リーグほど拮抗、上位リーグほど戦力差が広い」というティアごとの帯域幅を反映する。
function buildAiStrengths(baseline, count, halfWidth = AI_BAND_HALF_WIDTH) {
  const bands = Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1); // 0..1
    return -halfWidth + t * (halfWidth * 2); // -halfWidth..+halfWidth
  });
  // Fisher-Yates シャッフル
  for (let i = bands.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [bands[i], bands[j]] = [bands[j], bands[i]];
  }
  // 下限を極端に低くしすぎると弱小クラブ同士が同値で団子になり、順位が安定しなくなるため、
  // 15ではなく5まで許容して底のクラブ同士にもきちんと差がつくようにする。
  return bands.map(offset => clamp(Math.round(baseline + offset + randInt(-4, 4)), 5, ABILITY_CAP));
}

// トップ〜5軍(ADULT_KEYS)のうち、'top'は常にidが'me'(既存のトップ専用コードとの互換のため)、
// それ以外(2〜5軍)は'me_reserve'のような専用idを振る。
const ADULT_KEYS = ['top', ...RESERVE_LEVEL_KEYS];
function adultIdForKey(key) { return key === 'top' ? 'me' : `me_${key}`; }

// ライバルクラブ(RIVAL_CLUBS)の注入を、同じティアに同居する自チームぶんまとめて行う。
// injectRivalClubsは呼び出しごとにaiIds[0]から順にマッチさせるため、複数キー分を
// そのまま連続で呼ぶと枠の奪い合いが起きる。ここでは既に使った分だけaiIdsをずらして渡し、
// 重複を避ける。
function injectAllRivals(teams, aiIds, tierIdx, memberKeys) {
  let offset = 0;
  memberKeys.forEach(key => {
    const cat = key === 'top' ? 'top' : ACADEMY_LEAGUE_CATEGORY[key];
    const remaining = aiIds.slice(offset);
    const matched = injectRivalClubs(teams, remaining, cat, tierIdx, key === 'top', key === 'top' ? '' : TEAM_NAME_SUFFIX[key]);
    offset += matched.length;
  });
}

// 指定ティアに同居する自チーム(memberKeys、1〜5個)+AIクラブで20クラブぶんのリーグを1つ組む。
// 自チームが2つ以上いる場合、その2つが直接対戦するカードも生成される(通常の総当たりと同じ扱い)。
function buildAdultLeagueForTier(tierIdx, memberKeys, precomputedStrengths) {
  const baseStrength = TIER_BASELINE[tierIdx];
  const teams = {};
  const usedNames = new Set();
  memberKeys.forEach(key => {
    const name = key === 'top' ? state.club.name : `${state.club.name}${TEAM_NAME_SUFFIX[key]}`;
    teams[adultIdForKey(key)] = { name, strength: null };
    usedNames.add(name);
  });
  const aiCount = TEAM_COUNT - memberKeys.length;
  const strengths = precomputedStrengths || buildAiStrengths(baseStrength, aiCount, TIER_HALF_WIDTH[tierIdx]);
  const aiIds = [];
  for (let i = 0; i < aiCount; i++) {
    const id = 'ai' + i + '_' + state.season;
    let name;
    do { name = genClubName(); } while (usedNames.has(name));
    usedNames.add(name);
    teams[id] = { name, strength: strengths[i] };
    aiIds.push(id);
  }
  injectAllRivals(teams, aiIds, tierIdx, memberKeys);
  const standings = {};
  Object.keys(teams).forEach(id => { standings[id] = { played: 0, win: 0, draw: 0, lose: 0, gf: 0, ga: 0, pts: 0 }; });
  return {
    tier: tierIdx,
    memberKeys,
    teams,
    standings,
    fixtures: generateDoubleRoundRobin(Object.keys(teams)),
  };
}

// このシーズンの「トップ〜5軍」の同居グループを、各キーの現在ティア
// (トップ=state.club.tier、2〜5軍=state.club.reserveTier[key]、参戦中のみ)から再構築する。
// 2つ以上の自チームが同じティアにいれば1つの20クラブリーグに同居し(自チーム同士の対戦も
// 起こりうる)、1チームしかいないティアは従来どおり19AI+自チーム1のリーグになる。
// トップの所属ティアの結果は、既存のトップ専用コード(ファイナンス・カップ出場者生成・
// ダッシュボード等)がそのまま使えるよう、state.teams/standings/fixturesにも同じ
// オブジェクトを参照として割り当てる(=別名。JSON保存/復元時はpostLoadHousekeeping側で
// 参照を張り直す)。
function buildAdultLeagues(precomputedTopStrengths) {
  const membersByTier = {};
  (membersByTier[state.club.tier] || (membersByTier[state.club.tier] = [])).push('top');
  RESERVE_LEVEL_KEYS.forEach(key => {
    if (!state.club.reserveActive[key]) return;
    const t = state.club.reserveTier[key];
    (membersByTier[t] || (membersByTier[t] = [])).push(key);
  });

  const adultLeagues = {};
  Object.keys(membersByTier).forEach(tierStr => {
    const tierIdx = Number(tierStr);
    const memberKeys = membersByTier[tierIdx];
    const strengths = tierIdx === state.club.tier ? precomputedTopStrengths : undefined;
    adultLeagues[tierIdx] = buildAdultLeagueForTier(tierIdx, memberKeys, strengths);
  });
  state.club.adultLeagues = adultLeagues;

  const topLeague = adultLeagues[state.club.tier];
  state.teams = topLeague.teams;
  state.standings = topLeague.standings;
  state.fixtures = topLeague.fixtures;
}

function startSeason(tierIndex, precomputedStrengths) {
  state.club.tier = tierIndex;
  updateAdultLeagueParticipation();
  buildAdultLeagues(precomputedStrengths);
  state.currentRound = 0;
  state.phase = 'season';
  state.pendingDecision = null;
  state.lastDecisionRound = -99; // 週次意思決定のクールダウンをシーズンごとにリセット
  // シーズンごとのスタッツ(得点者・カード・出場記録)とリーグ戦の試合ログをまっさらにする。
  state.club.seasonStats = {};
  state.topMatchLog = [];
  generateMarket();
  generateAcademyCandidatesAll();
  autoSignAcademyCandidatesAll();
  refreshAffiliateCandidates();
  refreshAffiliateRosters();
  refreshSponsorCandidatesAll();
  initSeasonCups();
  // 今シーズン参戦する2〜5軍それぞれの下部組織カップ・成績ログも組み直す
  // (トップの各種カップと同じく、シーズンごとに1回開催)。
  RESERVE_LEVEL_KEYS.forEach(key => {
    if (!state.club.reserveActive[key]) return;
    initAcademyCup(key, state.club.reserveTier[key]);
    state.club.reserveMatchLog[key] = [];
  });
  // 開幕前に一度だけコンディションをまとめて回復させ、新シーズンを万全な状態で迎えられるようにする
  // (カップ戦はここではもう消化しない。リーグ戦の節ごとにplayRound()側で1ラウンドずつ進行する)。
  weekPlayedIds = new Set();
  applyWeeklyConditionRecovery();
}

// 順位表更新のコア処理。トップチームの順位表(state.standings)にも、下部組織の
// 各リーグ(state.club.academyLeagues[key].standings)にも同じロジックを使う。
function applyMatchToStandings(standings, homeId, awayId, hg, ag) {
  const home = standings[homeId];
  const away = standings[awayId];
  home.played++; away.played++;
  home.gf += hg; home.ga += ag;
  away.gf += ag; away.ga += hg;
  if (hg > ag) { home.win++; home.pts += 3; away.lose++; }
  else if (hg < ag) { away.win++; away.pts += 3; home.lose++; }
  else { home.draw++; away.draw++; home.pts++; away.pts++; }
}

function updateStandings(homeId, awayId, hg, ag) {
  applyMatchToStandings(state.standings, homeId, awayId, hg, ag);
}

function buildLeagueSortedTable(league) {
  return Object.keys(league.standings).map(id => {
    const s = league.standings[id];
    return { id, name: league.teams[id].name, ...s, gd: s.gf - s.ga };
  }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
}

function buildSortedTable() {
  return buildLeagueSortedTable({ teams: state.teams, standings: state.standings });
}

function applyWeeklyFinance(myMatchResult, homeKeys, topHomeMatchCount) {
  const tier = TIERS[state.club.tier];
  const rep = state.club.reputation;
  const econSqrt = Math.sqrt(tier.econ);
  const reserveHome = homeKeys.includes('reserve');
  const reserveLowerHome = ['reserve3', 'reserve4', 'reserve5'].some(k => homeKeys.includes(k));

  // 収入: 評判(rep)が上がるほど伸びる。ホームゲームのみメインスタジアムの収入が発生する。
  // スポンサー収入は「スポンサー」タブで契約している全体7枠+専用枠それぞれの合算。
  const sponsor = totalSponsorWeeklyIncome();
  // ticketはリーグ戦だけでなくカップ戦のホームゲームぶんも合算する(topHomeMatchCount)。
  // 同じ週にリーグ戦がアウェー・カップ戦がホームということがあり得るため、リーグ戦の
  // isHomeだけを見ているとカップ戦のホームゲーム収入が丸ごと抜け落ちてしまう。
  let ticket = 0;
  if (topHomeMatchCount > 0) {
    ticket = stadiumHomeIncome('top', econSqrt).total * topHomeMatchCount;
  }
  // 2軍スタジアム: 2軍がホームゲームの節のみ、同じくメインスタンド〜食事の5項目から収入が入る。
  let reserveIncome = 0;
  if (state.club.youthTeams.reserve && reserveHome) {
    reserveIncome = stadiumHomeIncome('reserve', econSqrt).total;
  }
  // 3〜5軍スタジアム(共用): 3〜5軍のいずれかがホームゲームの節のみ収入が入る。
  let reserveLowerIncome = 0;
  if (isCategoryOwned('reserveLower') && reserveLowerHome) {
    reserveLowerIncome = stadiumHomeIncome('reserveLower', econSqrt).total;
  }
  // ユース以下スタジアム: 対象年代のチームを1つでも所持していれば、毎週わずかな興行収入が入る
  // (ユース/ジュニアユース/U-12をまとめた簡易施設のため、特定の一試合には紐づけない)。
  let youthStadiumIncome = 0;
  if (isCategoryOwned('anyYouth')) {
    youthStadiumIncome = Math.round(bonusedLevel(state.club.facilities.youthStadium) * 10 * (0.4 + rep / 2500));
  }
  let matchBonus = 0;
  if (myMatchResult) {
    const winBonus = Math.round(20 * Math.sqrt(tier.econ));
    const drawBonus = Math.round(8 * Math.sqrt(tier.econ));
    if (myMatchResult.result === 'win') matchBonus = winBonus;
    else if (myMatchResult.result === 'draw') matchBonus = drawBonus;
  }
  // ショップ収入: 試合の有無・ホーム/アウェーに関係なく毎週加算される(唯一の非ホーム依存収入源)。
  const shop = shopWeeklyIncome(econSqrt);

  // 支出: 人件費は「そのティアの平均総合力(baseline)に対する比率」×econで計算する。
  // こうすることで、選手の総合力そのものではなく「今のティアの相場に対して高いか安いか」で
  // 給料が決まり、ティアが上がっても選手が育っても同じ物差しで難易度を保てる。
  const wages = Math.round(state.club.players.reduce((s, p) => {
    return s + (p.overall / tier.baseline) * AVG_WAGE_PER_PLAYER * tier.econ;
  }, 0));
  const maintenance = totalFacilityMaintenance();
  const affiliateMaint = totalAffiliateMaintenance();

  // マイルストーンの恒久収入ボーナス(企画書12.4)を全収入に乗せる。
  const incomeBase = sponsor + ticket + reserveIncome + reserveLowerIncome + youthStadiumIncome + matchBonus + shop;
  const income = Math.round(incomeBase * recordsBonusMult());
  const expense = wages + maintenance + affiliateMaint;
  state.club.money += income - expense;
  // クラブランクの財政健全度スコアはこの週次収支(特に支出)を基準にランウェイを計算するため保存しておく。
  state.club.finance = { income, expense };
  return { income, expense };
}

// フラット施設(スカウト・ユース以下スタジアム)+ スタジアムバンドル + 年代別「練習場」バンドルの
// 全レベル合計から維持費を算出する。
function totalFacilityMaintenance() {
  const f = state.club.facilities;
  let sum = 0;
  ['scout', 'youthStadium', 'scoutYouth', 'scoutJuniorYouth', 'scoutU12',
   'shopRegional', 'shopOnline', 'shopOverseas', 'shopLicense'].forEach(key => {
    sum += FACILITY_MAINT_MULT.flat * Math.pow(f[key] || 0, FACILITY_MAINT_EXP);
  });
  Object.values(f.grounds).forEach(bundle => {
    Object.values(bundle).forEach(lv => { sum += FACILITY_MAINT_MULT.ground * Math.pow(lv, FACILITY_MAINT_EXP); });
  });
  Object.values(f.stadiums).forEach(bundle => {
    Object.values(bundle).forEach(lv => { sum += FACILITY_MAINT_MULT.stadium * Math.pow(lv, FACILITY_MAINT_EXP); });
  });
  Object.values(f.shopStadium).forEach(lv => { sum += FACILITY_MAINT_MULT.shop * Math.pow(lv, FACILITY_MAINT_EXP); });
  Object.values(f.shopGround).forEach(lv => { sum += FACILITY_MAINT_MULT.shop * Math.pow(lv, FACILITY_MAINT_EXP); });
  Object.values(f.shopProducts).forEach(lv => { sum += FACILITY_MAINT_MULT.shop * Math.pow(lv, FACILITY_MAINT_EXP); });
  return Math.round(sum);
}

function logMatch(m, finance) {
  if (!m) { addLog('今節は試合データがありません。'); return; }
  const resultText = m.result === 'win' ? `${m.myGoals}-${m.oppGoals} 勝利 🎉`
    : m.result === 'draw' ? `${m.myGoals}-${m.oppGoals} 引き分け`
    : `${m.myGoals}-${m.oppGoals} 敗北`;
  const vsText = m.isHome ? `(H) vs ${m.oppName}` : `(A) vs ${m.oppName}`;
  const type = m.result === 'win' ? 'good' : (m.result === 'lose' ? 'bad' : '');
  addLog(`${vsText}: ${resultText} ｜ 収入${fmtMoney(finance.income)} / 支出${fmtMoney(finance.expense)}`, type);
}

// 「試合を行う」の1クリックぶんで観戦可能になった試合(リーグ戦+同じ週に重なったランク別
// カップ)を順番に並べるキュー。playRound()が消化のたびに詰め直し、playNextQueuedMatch()が
// 1つずつ試合観戦モーダルで再生する。
let matchViewQueue = [];

// idが自チーム(トップ='me'、2〜5軍='me_reserve'等)なら対応するキー('top'/'reserve'等)を、
// AIクラブなら null を返す。
function ownKeyForId(id) {
  if (id === 'me') return 'top';
  if (id.startsWith('me_')) return id.slice(3);
  return null;
}

// トップ('top')以外の自チーム(2〜5軍)が絡む対戦結果を、そのキーの成績ログ
// (state.club.reserveMatchLog[key])に記録する(順位表タブの「試合結果を見る」用)。
function recordAdultOwnMatch(teams, homeId, awayId, homeOwnKey, awayOwnKey, hg, ag, roundNum) {
  [[homeOwnKey, true, awayId], [awayOwnKey, false, homeId]].forEach(([ownKey, isHome, oppId]) => {
    if (!ownKey || ownKey === 'top') return;
    const myGoals = isHome ? hg : ag;
    const oppGoals = isHome ? ag : hg;
    const result = myGoals > oppGoals ? 'win' : myGoals === oppGoals ? 'draw' : 'lose';
    if (!state.club.reserveMatchLog[ownKey]) state.club.reserveMatchLog[ownKey] = [];
    state.club.reserveMatchLog[ownKey].push({ round: roundNum, isHome, oppName: teams[oppId].name, myGoals, oppGoals, result });
  });
}

// adultLeaguesの1エントリ(トップの所属ティア、またはトップ不在で2〜5軍だけが同居する
// 他ティア)について、現在の節(roundIdx)ぶんを消化する。
// ・トップ('me')がAIクラブと対戦 → 既存の詳細演出パイプライン(観戦・選手イベント)。
// ・それ以外(2〜5軍がAIクラブと対戦、または自チーム同士の対戦)→ 簡易集計のみ
//   (個々の選手イベント・観戦は無し。トップが絡む場合でもコンディション消耗・出場記録は
//   通常どおり発生させる)。
// 戻り値: トップ自身の試合結果(myMatchResult、トップ不在のリーグではnull)と、
// このリーグでホームだった自チームキーの一覧(homeKeys)。
function simulateAdultLeagueRound(league, roundIdx) {
  const round = league.fixtures[roundIdx];
  const teams = league.teams;
  let myMatchResult = null;
  const homeKeys = [];
  round.forEach(([homeId, awayId]) => {
    const homeOwnKey = ownKeyForId(homeId);
    const awayOwnKey = ownKeyForId(awayId);
    if (homeOwnKey) homeKeys.push(homeOwnKey);
    const soloTopVsAi = (homeId === 'me' && !awayOwnKey) || (awayId === 'me' && !homeOwnKey);
    if (soloTopVsAi) {
      const homeStrength = homeId === 'me' ? playMyTopMatch() : teams[homeId].strength;
      const awayStrength = awayId === 'me' ? playMyTopMatch() : teams[awayId].strength;
      const [hg, ag] = simulateMatch(homeStrength, awayStrength);
      applyMatchToStandings(league.standings, homeId, awayId, hg, ag);
      const isHome = homeId === 'me';
      const myGoals = isHome ? hg : ag;
      const oppGoals = isHome ? ag : hg;
      const oppName = isHome ? teams[awayId].name : teams[homeId].name;
      const result = myGoals > oppGoals ? 'win' : myGoals === oppGoals ? 'draw' : 'lose';
      myMatchResult = { isHome, myGoals, oppGoals, oppName, result };
      const events = generateTopMatchEvents(lastPlayedXI, myGoals, oppGoals, oppName, turfLevel());
      applyTopMatchEventConsequences(events, lastPlayedXI, result);
      const detail = { competition: 'リーグ戦', round: roundIdx + 1, isHome, oppName, myGoals, oppGoals, result, events };
      state.topMatchLog.push(detail);
      matchViewQueue.push(detail);
    } else if (homeOwnKey || awayOwnKey) {
      const homeStrength = homeOwnKey === 'top' ? playMyTopMatch() : homeOwnKey ? academyLeagueTeamStrength(homeOwnKey) : teams[homeId].strength;
      const awayStrength = awayOwnKey === 'top' ? playMyTopMatch() : awayOwnKey ? academyLeagueTeamStrength(awayOwnKey) : teams[awayId].strength;
      const [hg, ag] = simulateMatch(homeStrength, awayStrength);
      applyMatchToStandings(league.standings, homeId, awayId, hg, ag);
      recordAdultOwnMatch(teams, homeId, awayId, homeOwnKey, awayOwnKey, hg, ag, roundIdx + 1);
    } else {
      const [hg, ag] = simulateMatch(teams[homeId].strength, teams[awayId].strength);
      applyMatchToStandings(league.standings, homeId, awayId, hg, ag);
    }
  });
  return { myMatchResult, homeKeys };
}

function simulateOneRound() {
  weekPlayedIds = new Set();
  const top = simulateAdultLeagueRound(state.club.adultLeagues[state.club.tier], state.currentRound);
  const myMatchResult = top.myMatchResult;
  const homeKeys = [...top.homeKeys];
  // トップと同居していない2〜5軍(別ティアで独自に組まれているリーグ)も、同じ節番号で消化する。
  Object.keys(state.club.adultLeagues).forEach(tierStr => {
    const tierIdx = Number(tierStr);
    if (tierIdx === state.club.tier) return;
    const r = simulateAdultLeagueRound(state.club.adultLeagues[tierIdx], state.currentRound);
    homeKeys.push(...r.homeKeys);
  });
  // カップ戦は、対応する節番号に到達したときだけ1ラウンドぶん消化する(リーグ戦と同じ週に
  // 重なることで、過密日程による疲労が生まれる)。
  const leagueCupDetail = resolveScheduledCupWeek(state.leagueCup, 0.6);
  if (leagueCupDetail) { leagueCupDetail.competition = 'リーグカップ'; matchViewQueue.push(leagueCupDetail); }
  const worldCupDetail = resolveWorldCupWeek();
  if (worldCupDetail) { worldCupDetail.competition = 'ワールドピラミッドカップ'; matchViewQueue.push(worldCupDetail); }
  const contDetail = resolveScheduledCupWeek(state.continentalCup, 1);
  if (contDetail) { contDetail.competition = '大陸カップ'; matchViewQueue.push(contDetail); }
  const worldClubDetail = resolveScheduledCupWeek(state.worldClubCup, 2);
  if (worldClubDetail) { worldClubDetail.competition = 'ワールドクラブカップ'; matchViewQueue.push(worldClubDetail); }
  const champCupDetail = resolveChampionsCupWeek();
  if (champCupDetail) { champCupDetail.competition = '大陸チャンピオンズカップ'; matchViewQueue.push(champCupDetail); }
  simulateAcademyLeaguesRound();
  RESERVE_LEVEL_KEYS.forEach(key => {
    if (state.club.reserveActive[key]) resolveAcademyCupWeek(key, state.currentRound);
  });
  applyWeeklyConditionRecovery();
  // その週にトップチームがホームで戦った試合の本数(リーグ戦+カップ戦を全て含む)。
  // リーグ戦がアウェーでもカップ戦がホームなら、その分のスタジアム収入は発生する
  // (逆に同じ週にホームゲームが2つ重なれば、その分収入も積み上がる)。
  const topHomeMatchCount = [myMatchResult, leagueCupDetail, worldCupDetail, contDetail, worldClubDetail, champCupDetail]
    .filter(d => d && d.isHome).length;
  const finance = applyWeeklyFinance(myMatchResult, homeKeys, topHomeMatchCount);
  logMatch(myMatchResult, finance);
  state.currentRound++;
  if (state.currentRound >= state.fixtures.length) {
    endSeason();
  } else if (isMarketRefreshRound(state.currentRound, state.fixtures.length)) {
    generateMarket();
    generateAcademyCandidatesAll();
    autoSignAcademyCandidatesAll();
    addLog('移籍市場の候補が入れ替わりました。', 'gold');
  }
}

function playRound() {
  if (state.phase !== 'season') return;
  // 週次意思決定(企画書12.6): 節を進める前に、条件を満たせば1つだけ決断を挟む。
  if (!state.pendingDecision && maybeRollWeeklyDecision()) {
    save();
    openDecisionModal();
    return;
  }
  proceedRound();
}

// 実際に1節を消化する処理本体(playRound / resolveWeeklyDecision の両方から呼ぶ)。
function proceedRound() {
  matchViewQueue = [];
  simulateOneRound();
  checkMilestones();
  save();
  if (matchViewQueue.length) {
    playNextQueuedMatch();
  } else {
    maybeOpenSeasonReview();
  }
}

function playNextQueuedMatch() {
  if (!matchViewQueue.length) { maybeOpenSeasonReview(); return; }
  const detail = matchViewQueue.shift();
  openMatchViewer(detail, matchViewQueue.length ? playNextQueuedMatch : maybeOpenSeasonReview);
}

// デバッグ用: 現在のシーズンの残り試合を一括で消化し、オフシーズンまで一気に進める。
function debugFinishSeason() {
  let guard = 0;
  while (state.phase === 'season' && guard < 200) {
    simulateOneRound();
    guard++;
  }
  save();
  maybeOpenSeasonReview();
}

// 成長期(23歳未満)を過ぎた選手は、もう伸びしろを使い切ったとみなし、潜在能力を
// 毎シーズン少しずつ「今の能力値」へ近づける(差を一定割合ずつ縮める減衰)。
// これにより、育成しきれなかった選手や年齢を重ねた選手の潜在能力が、いつまでも
// 現在の能力値より大幅に高いまま表示され続けることを防ぐ。
const POTENTIAL_DECAY_START_AGE = 23;
const POTENTIAL_DECAY_RATE = 0.25;

// 年代ごとの成長速度の倍率。10代半ば〜後半(伸び盛り)を最速にし、そこから前後に
// 離れるほど遅くする(U-12はまだ体ができておらず伸びが穏やか、23歳以降は
// トップチームでは成長期を終える一方、2軍以下では稀に伸び続ける選手もいるため
// 低倍率でごく緩やかに成長を継続させる)。
const GROWTH_AGE_BANDS = [
  { max: 12, mult: 0.5 },
  { max: 15, mult: 0.8 },
  { max: 18, mult: 1.3 },
  { max: 21, mult: 1.1 },
  { max: 23, mult: 0.75 },
  { max: Infinity, mult: 0.4 },
];
function growthAgeMultiplier(age) {
  return GROWTH_AGE_BANDS.find(b => age <= b.max).mult;
}

function growAndAgePlayers() {
  const g = state.club.facilities.grounds.top;
  const trainingLv = g.pitch;
  const medicalLv = g.medical;
  const retired = [];
  let grownCount = 0;
  let totalGrowth = 0;
  const grownList = [];
  state.club.players.forEach(p => {
    const beforeOverall = p.overall;
    const wasGrowing = p.age < 23 && p.overall < p.potential;
    if (wasGrowing) {
      // 練習場Lvはそのまま成長ボーナスに直結させる(以前は2Lvごとに+1でレベルアップの
      // 恩恵が感じにくかったため、1Lv上げるごとに必ず+1増えるようにした)。
      const baseGrowth = randInt(2, 4) + trainingLv + Math.floor(g.pool / 2) + Math.round(coachOverallGrowthBonus('top')) + Math.round(sponsorGrowthBonus('top'));
      const growth = Math.max(1, Math.round(baseGrowth * growthAgeMultiplier(p.age)));
      p.overall = Math.min(p.potential, p.overall + growth);
      // 照明Lvぶん、成長期の選手はさらに潜在能力の伸びしろが引き出される(下部組織側の
      // runAcademy()と同じ調整をトップチームにも揃える)。
      if (p.potential < ABILITY_CAP) {
        p.potential = clamp(p.potential + Math.floor(g.lighting / 2), p.potential, ABILITY_CAP);
      }
    } else if (p.age >= 30) {
      const declineChance = clamp(0.4 - medicalLv * 0.05 - g.turf * 0.02, 0.05, 0.4);
      if (Math.random() < declineChance) {
        p.overall = Math.max(28, p.overall - randInt(1, 3));
      }
    }
    if (p.overall !== beforeOverall) {
      applyAttributeDelta(p, p.overall - beforeOverall);
    }
    if (wasGrowing) {
      COACH_ATTR_ROLES.forEach(attr => {
        p[attr] = clamp(p[attr] + Math.round(coachAttrGrowthBonus('top', attr)), 1, ABILITY_CAP);
      });
      if (p.overall > beforeOverall) {
        grownCount++;
        totalGrowth += p.overall - beforeOverall;
        grownList.push({ name: p.name, pos: p.pos, category: 'top', before: beforeOverall, after: p.overall });
      }
    }
    if (p.age >= POTENTIAL_DECAY_START_AGE && p.potential > p.overall) {
      p.potential = Math.max(p.overall, Math.round(p.potential - (p.potential - p.overall) * POTENTIAL_DECAY_RATE));
    }
    p.age += 1;
    if (p.age > 36) retired.push(p);
  });
  // 引退自体(38節終了時点で37歳以上)は不可避の自動処理。ただし引退後の身の振り方
  // (何もしない/提携クラブへコーチ斡旋/自クラブのコーチに招聘)はシーズン終了レビュー画面で
  // オーナーが選手ごとに決められるよう、ここでは選手をスカッドから抜くところまでに留め、
  // 実際の斡旋処理(brokerRetiredPlayersAsCoaches)や自クラブコーチ就任は
  // applySeasonEndDecisions() に委ねる。
  const retirees = retired.map(p => ({ id: p.id, name: p.name, pos: p.pos, age: p.age, overall: p.overall, potential: p.potential }));
  if (retired.length) {
    const retiredIds = retired.map(p => p.id);
    state.club.players = state.club.players.filter(p => !retiredIds.includes(p.id));
  }

  // クラブの魅力(評判)に見合わない実力者ほど、他クラブへ引き抜かれる(離脱する)リスクがある。
  // 最低限のスカッド人数(11人)は必ず確保する。これは選手側の意思による離脱でオーナーの
  // 決定事項ではないため、従来通り自動処理のまま(結果はログ・レビュー画面に表示するのみ)。
  const poachable = state.club.players.filter(p => Math.random() < departureRisk(p.overall, state.club.reputation, 0.15));
  let poachedTopNames = [];
  if (poachable.length && state.club.players.length - poachable.length >= 11) {
    const poachedIds = new Set(poachable.map(p => p.id));
    const tierMult = TIER_PRICE_MULT[state.club.tier];
    const feeTotal = poachable.reduce((sum, p) => sum + Math.round((p.overall * 8 + p.potential * 6) * tierMult * 0.4), 0);
    poachable.forEach(p => inductHallOfFame(p, '引き抜き'));
    state.club.players = state.club.players.filter(p => !poachedIds.has(p.id));
    state.club.money += feeTotal;
    poachedTopNames = poachable.map(p => p.name);
    addLog(`クラブの魅力(評判)不足により ${poachedTopNames.join('、')} が他クラブへ引き抜かれました。(+${fmtMoney(feeTotal)})`, 'bad');
  }

  while (state.club.players.length < 14) {
    const pos = weightedPositionWithQuota(state.club.players, squadCap());
    state.club.players.push(createPlayer(pos, randInt(18, 23), randInt(35, 45)));
  }

  return { grownCount, totalGrowth, grownList, retirees, poachedTopNames };
}

// U-12所持数・スカウトに応じて新規発掘 → 年齢に応じて年代ブラケットを進級 → 上位カテゴリの
// チームを所持していなければ離脱。reserve(2〜5軍)には年齢上限が無いため、そこから先は
// processReserveGraduation()が毎シーズンの継続的なトップチーム昇格/引き抜き判定を行う。
function runAcademy() {
  const club = state.club;
  const prospects = club.academy.prospects;

  const u12Count = u12OwnedCount();
  if (u12Count > 0) {
    const scoutLv = club.facilities.scoutU12;
    const intensity = scoutLv / FACILITY_BASE_MAX;
    const tierIdx = academyCategoryTierIdx('u12');
    const baseline = academyBaselineForTier('u12', tierIdx);
    const halfWidth = TIER_HALF_WIDTH[tierIdx];
    const cap = categoryCapacity('u12');
    for (let i = 0; i < u12Count; i++) {
      const u12Prospects = prospects.filter(p => p.category === 'u12');
      if (u12Prospects.length >= cap) break;
      const age = randInt(10, 11);
      const overall = tierRelativeOverall(baseline, halfWidth, intensity);
      // U-12練習場の照明(lighting)Lvぶん、発掘する新人の潜在能力を底上げする(top側と同じ考え方)。
      const lightingBonus = club.facilities.grounds.u12.lighting * 2;
      const potential = clamp(applyPotentialGuardrail(overall, 'u12', tierIdx, intensity) + lightingBonus, overall, ABILITY_CAP);
      const pos = weightedPositionWithQuota(u12Prospects, cap);
      prospects.push({ id: uid(), name: genPlayerName(), pos, age, overall, potential, category: 'u12', ...generateAttributes(pos, overall) });
    }
  }

  // ジュニアユース/ユースは(u12を経由した昇格とは別に)チームを所持していればそれぞれの
  // スカウト施設(scoutJuniorYouth/scoutYouth)に応じて毎シーズン1人、外部から直接新加入する。
  // u12を持たずにジュニアユース/ユースだけを所持しているクラブでも選手が入ってくるようにするため。
  if (club.youthTeams.juniorYouth) {
    const scoutLv = scoutLevelForCategory('juniorYouth');
    const intensity = scoutLv / FACILITY_BASE_MAX;
    const tierIdx = academyCategoryTierIdx('juniorYouth');
    const baseline = academyBaselineForTier('juniorYouth', tierIdx);
    const halfWidth = TIER_HALF_WIDTH[tierIdx];
    const cap = categoryCapacity('juniorYouth');
    const jyProspects = prospects.filter(p => p.category === 'juniorYouth');
    if (jyProspects.length < cap) {
      const age = randInt(13, 14);
      const overall = tierRelativeOverall(baseline, halfWidth, intensity);
      const lightingBonus = club.facilities.grounds.juniorYouth.lighting * 2;
      const potential = clamp(applyPotentialGuardrail(overall, 'juniorYouth', tierIdx, intensity) + lightingBonus, overall, ABILITY_CAP);
      const pos = weightedPositionWithQuota(jyProspects, cap);
      prospects.push({ id: uid(), name: genPlayerName(), pos, age, overall, potential, category: 'juniorYouth', ...generateAttributes(pos, overall) });
    }
  }
  if (club.youthTeams.youth) {
    const scoutLv = scoutLevelForCategory('youth');
    const intensity = scoutLv / FACILITY_BASE_MAX;
    const tierIdx = academyCategoryTierIdx('youth');
    const baseline = academyBaselineForTier('youth', tierIdx);
    const halfWidth = TIER_HALF_WIDTH[tierIdx];
    const cap = categoryCapacity('youth');
    const yProspects = prospects.filter(p => p.category === 'youth');
    if (yProspects.length < cap) {
      const age = randInt(16, 17);
      const overall = tierRelativeOverall(baseline, halfWidth, intensity);
      const lightingBonus = club.facilities.grounds.youth.lighting * 2;
      const potential = clamp(applyPotentialGuardrail(overall, 'youth', tierIdx, intensity) + lightingBonus, overall, ABILITY_CAP);
      const pos = weightedPositionWithQuota(yProspects, cap);
      prospects.push({ id: uid(), name: genPlayerName(), pos, age, overall, potential, category: 'youth', ...generateAttributes(pos, overall) });
    }
  }

  // reserveプール(2〜5軍)は能力上位からADULT_SQUAD_BASE_CAP(26)人ずつ切り出し、
  // 2軍=上位26人・3軍=次の26人・4軍=次の26人・5軍=それ以降、という階層として扱う
  // (tieredLevelPoolと同じ切り出し方)。練習場・コーチの成長ボーナスは、この階層に
  // 対応する 'reserve'/'reserve3'/'reserve4'/'reserve5' の練習場を個別に参照する。
  const reserveRankIndex = new Map(
    prospects.filter(p => p.category === 'reserve')
      .sort((a, b) => b.overall - a.overall)
      .map((p, i) => [p.id, i])
  );
  const growthCategoryFor = (p) => {
    if (p.category !== 'reserve') return p.category;
    const rank = reserveRankIndex.get(p.id) || 0;
    const levelIdx = Math.min(Math.floor(rank / ADULT_SQUAD_BASE_CAP), RESERVE_LEVEL_KEYS.length - 1);
    return RESERVE_LEVEL_KEYS[levelIdx];
  };

  let releasedCount = 0;
  let poachedCount = 0;
  let grownCount = 0;
  let totalGrowth = 0;
  const grownList = [];
  // 年代ブラケットが上がるタイミング(所属チームが所持済みで、引き抜きにも遭わなかった選手)は
  // ここで即座に昇格させず、シーズン終了レビュー画面で「昇格させる/リリースする」を
  // オーナーが選手ごとに選べるよう候補として集める(applySeasonEndDecisions()で確定反映)。
  const promoCandidates = [];
  for (let i = prospects.length - 1; i >= 0; i--) {
    const p = prospects[i];
    p.age += 1;
    const growthCat = growthCategoryFor(p);
    const g = club.facilities.grounds[growthCat];
    // 練習場Lvはそのまま成長ボーナスに直結させる(top team側と同じ調整)。
    const baseGrowth = randInt(2, 4) + g.pitch + Math.floor(g.pool / 2) + Math.round(avgCoachBonusForCategory(growthCat, coachOverallGrowthBonus)) + Math.round(sponsorGrowthBonus(p.category));
    const growth = Math.max(1, Math.round(baseGrowth * growthAgeMultiplier(p.age)));
    if (p.overall < p.potential) {
      const beforeOverall = p.overall;
      p.overall = Math.min(p.potential, p.overall + growth);
      applyAttributeDelta(p, p.overall - beforeOverall);
      COACH_ATTR_ROLES.forEach(attr => {
        p[attr] = clamp(p[attr] + Math.round(avgCoachBonusForCategory(growthCat, k => coachAttrGrowthBonus(k, attr))), 1, ABILITY_CAP);
      });
      if (p.overall > beforeOverall) {
        grownCount++;
        totalGrowth += p.overall - beforeOverall;
        grownList.push({ name: p.name, pos: p.pos, category: p.category, before: beforeOverall, after: p.overall });
      }
      // 照明Lvぶん、成長期の選手はさらに潜在能力の伸びしろが引き出される(トップチームの
      // 新加入選手向けボーナスと同じ考え方を、成長し続けている間は毎シーズン適用する)。
      if (p.potential < ABILITY_CAP) {
        p.potential = clamp(p.potential + Math.floor(g.lighting / 2), p.potential, ABILITY_CAP);
      }
    } else if (p.age >= 30) {
      // reserveプール(2〜5軍)は年齢上限が無いため、トップチームと同じくベテラン選手の
      // 能力低下を医療施設・芝(turf)で抑える(top側のgrowAndAgePlayers()と同じ調整式)。
      const declineChance = clamp(0.4 - g.medical * 0.05 - g.turf * 0.02, 0.05, 0.4);
      if (Math.random() < declineChance) {
        const beforeOverall = p.overall;
        p.overall = Math.max(20, p.overall - randInt(1, 3));
        applyAttributeDelta(p, p.overall - beforeOverall);
      }
    }

    const bracket = ACADEMY_BRACKETS.find(b => p.age >= b.minAge && p.age <= b.maxAge);
    if (!bracket) continue;
    if (bracket.key !== p.category) {
      if (!isCategoryOwned(bracket.key)) {
        releasedCount++;
        prospects.splice(i, 1);
        continue;
      }
      // 年代が上がる節目は、クラブの魅力(評判)に見合わない有望株ほど他クラブへ
      // 引き抜かれるリスクが高くなる(通常のシーズン経過より高いmultiplierを使う)。
      const promoteQuality = p.overall * 0.4 + p.potential * 0.6;
      if (Math.random() < departureRisk(promoteQuality, club.reputation, 1)) {
        poachedCount++;
        prospects.splice(i, 1);
        continue;
      }
      promoCandidates.push({
        id: p.id, name: p.name, pos: p.pos, age: p.age, overall: p.overall, potential: p.potential,
        kind: 'bracket', fromCategory: p.category, toCategory: bracket.key, decision: 'promote',
      });
    }
  }

  if (releasedCount) addLog(`アカデミーから${releasedCount}名が卒業・離脱しました。`);
  if (poachedCount) addLog(`クラブの魅力(評判)が足りず、年代が上がるタイミングで${poachedCount}名の有望株が他クラブに引き抜かれました。`, 'bad');

  return { grownCount, totalGrowth, grownList, promoCandidates, releasedCount, poachedCount };
}

// ---------- ユース以下スカウト候補(トップチームの移籍市場と同じく、能動的に選んで獲得) ----------
// runAcademy()の自動加入(待っているだけで少しずつ増える無償の新加入)とは別枠。
// こちらはシーズンごとにスカウト施設レベルに応じた候補を複数人リストアップし、
// オーナーが気に入った選手だけを選んで無償で獲得できるようにする。
const ACADEMY_SCOUT_FACILITY_KEY = { u12: 'scoutU12', juniorYouth: 'scoutJuniorYouth', youth: 'scoutYouth' };
const ACADEMY_CANDIDATE_AGE = { u12: [10, 11], juniorYouth: [13, 14], youth: [16, 17] };

function academyCandidateCount(cat) {
  const scoutLv = scoutLevelForCategory(cat);
  const scoutRatio = clamp(scoutLv / FACILITY_BASE_MAX, 0, 1);
  const teams = cat === 'u12' ? Math.max(1, u12OwnedCount()) : 1;
  return Math.min(6, teams * (1 + Math.round(scoutRatio * 2)));
}

function makeAcademyCandidate(cat) {
  const scoutLv = scoutLevelForCategory(cat);
  const intensity = scoutLv / FACILITY_BASE_MAX;
  const [minAge, maxAge] = ACADEMY_CANDIDATE_AGE[cat];
  const age = randInt(minAge, maxAge);
  const tierIdx = academyCategoryTierIdx(cat);
  const baseline = academyBaselineForTier(cat, tierIdx);
  const halfWidth = TIER_HALF_WIDTH[tierIdx];
  const overall = tierRelativeOverall(baseline, halfWidth, intensity);
  const lightingBonus = state.club.facilities.grounds[cat].lighting * 2;
  const potential = clamp(applyPotentialGuardrail(overall, cat, tierIdx, intensity) + lightingBonus, overall, ABILITY_CAP);
  const existing = state.club.academy.prospects.filter(p => p.category === cat);
  const pos = weightedPositionWithQuota(existing, categoryCapacity(cat));
  return { id: uid(), name: genPlayerName(), pos, age, overall, potential, category: cat, ...generateAttributes(pos, overall) };
}

function generateAcademyCandidates(cat) {
  if (!isCategoryOwned(cat)) { state.academyCandidates[cat] = []; return; }
  const count = academyCandidateCount(cat);
  state.academyCandidates[cat] = Array.from({ length: count }, () => makeAcademyCandidate(cat));
}

function generateAcademyCandidatesAll() {
  ['u12', 'juniorYouth', 'youth'].forEach(generateAcademyCandidates);
}

function signAcademyCandidate(cat, id) {
  const list = state.academyCandidates[cat];
  if (!list) return;
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return;
  const cap = categoryCapacity(cat);
  const current = state.club.academy.prospects.filter(p => p.category === cat).length;
  if (current >= cap) { toast('在籍上限のため獲得できません'); return; }
  const candidate = list[idx];
  list.splice(idx, 1);
  state.club.academy.prospects.push(candidate);
  addLog(`${ACADEMY_CATEGORY_LABEL[cat] || cat}に${candidate.name}をスカウトしました。`, 'good');
  save();
  render();
}

// 企画書12.6(委任): 「自動スカウト」がONのカテゴリについて、無償候補を能力順に
// 在籍上限まで自動獲得する。候補生成のたび(シーズン開始・移籍市場更新・新設直後)に呼ぶ。
function toggleAcademyAutopilot(cat) {
  if (!state.club.academyAutopilot) state.club.academyAutopilot = { u12: false, juniorYouth: false, youth: false };
  state.club.academyAutopilot[cat] = !state.club.academyAutopilot[cat];
  if (state.club.academyAutopilot[cat]) autoSignAcademyCandidates(cat);
  save();
  render();
}
function autoSignAcademyCandidates(cat) {
  if (!state.club.academyAutopilot || !state.club.academyAutopilot[cat]) return;
  const list = state.academyCandidates[cat];
  if (!list || !list.length) return;
  const cap = categoryCapacity(cat);
  let current = state.club.academy.prospects.filter(p => p.category === cat).length;
  const sorted = [...list].sort((a, b) => b.overall - a.overall);
  const signed = [];
  sorted.forEach(candidate => {
    if (current >= cap) return;
    const idx = list.findIndex(p => p.id === candidate.id);
    if (idx < 0) return;
    list.splice(idx, 1);
    state.club.academy.prospects.push(candidate);
    signed.push(candidate.name);
    current++;
  });
  if (signed.length) addLog(`【自動スカウト】${ACADEMY_CATEGORY_LABEL[cat] || cat}: ${signed.join('、')} を獲得しました。`, 'good');
}
function autoSignAcademyCandidatesAll() {
  ['u12', 'juniorYouth', 'youth'].forEach(autoSignAcademyCandidates);
}

// reserveプール(2〜5軍)には年齢上限が無いため、22歳での強制卒業イベントの代わりに、
// シーズンごとにプール全員へ「引き抜きリスク(トップチームの通常週次と同じ弱い係数)」を
// 判定する(不可避・自動)。引き抜かれなかった選手は基本的にそのまま2軍以下に残り続け、
// シーズン終了時に昇格/リリースを強制されることはない(トップチームへの昇格は
// 「ユース組織」タブのreorganizeTopByAbility()等でオーナーが好きなタイミングに行う)。
function processReserveGraduation() {
  const club = state.club;
  const prospects = club.academy.prospects;
  let poachedCount = 0;
  const reserveList = prospects.filter(p => p.category === 'reserve').sort((a, b) => b.overall - a.overall);
  reserveList.forEach(p => {
    const quality = p.overall * 0.5 + p.potential * 0.5;
    if (Math.random() < departureRisk(quality, club.reputation, 0.15)) {
      poachedCount++;
      const idx = prospects.indexOf(p);
      if (idx >= 0) prospects.splice(idx, 1);
    }
  });
  if (poachedCount) addLog(`クラブの魅力(評判)が足りず、2軍以下から${poachedCount}名の選手が他クラブに引き抜かれました。`, 'bad');
  return { poachedCount };
}

// 下部組織の1つのリーグ(reserve/youth/youthReserve/juniorYouth/juniorYouthReserve/
// u12_1〜5)を、指定ティアで新規に組む(19のAIクラブ+自クラブの20クラブ)。
function startAcademyLeagueSeason(key, tierIdx) {
  const cat = ACADEMY_LEAGUE_CATEGORY[key];
  const baseline = academyBaselineForTier(cat, tierIdx);
  const strengths = buildAiStrengths(baseline, TEAM_COUNT - 1, TIER_HALF_WIDTH[tierIdx]);
  const myName = `${state.club.name}${TEAM_NAME_SUFFIX[key]}`;
  const teams = { me: { name: myName, strength: null } };
  const usedNames = new Set([myName]);
  const aiIds = [];
  for (let i = 0; i < TEAM_COUNT - 1; i++) {
    let name;
    do { name = `${genClubName()}${TEAM_NAME_SUFFIX[key]}`; } while (usedNames.has(name));
    usedNames.add(name);
    const id = 'ai' + i;
    teams[id] = { name, strength: strengths[i] };
    aiIds.push(id);
  }
  // u12_2〜5は同じライバルが複数リーグに同時出現しないよう、代表として u12_1 のみで判定する。
  if (['reserve', 'youth', 'juniorYouth', 'u12_1'].includes(key)) {
    injectRivalClubs(teams, aiIds, cat, tierIdx, false, TEAM_NAME_SUFFIX[key]);
  }
  const standings = {};
  Object.keys(teams).forEach(id => { standings[id] = { played: 0, win: 0, draw: 0, lose: 0, gf: 0, ga: 0, pts: 0 }; });
  // U-12の各チーム(u12_1〜5)は同じ育成プールを共有していても別地域のクラブとして扱うため、
  // シーズンごとに固有の戦力値をこのティアの目安帯から割り当てる(他年代はプールから算出)。
  const myStrength = key.startsWith('u12_') ? clamp(Math.round(baseline + randInt(-10, 10)), 5, ABILITY_CAP) : null;
  state.club.academyLeagues[key] = {
    tier: tierIdx,
    teams,
    standings,
    fixtures: generateDoubleRoundRobin(['me', ...aiIds]),
    currentRound: 0,
    myStrength,
    myMatchLog: [],
  };
  initAcademyCup(key, tierIdx);
}

// トップチームの1節ぶんの試合が行われるたびに、所持している下部組織リーグも
// すべて1節ぶん同時に消化する。
// ユース/ジュニアユース/U-12(独自クロックを持つ旧エンジン側)のみを対象にする。
// 2〜5軍(RESERVE_LEVEL_KEYS)はstate.club.academyLeaguesを使わなくなった
// (simulateOneRound()内でadultLeagues経由に処理済み)ため、ここでは常にnullとなり
// 自動的にスキップされる。
function simulateAcademyLeaguesRound() {
  updateReserveLeagueParticipation();
  Object.keys(state.club.academyLeagues).forEach(key => {
    const league = state.club.academyLeagues[key];
    if (!league) return;
    const round = league.fixtures[league.currentRound];
    const myStrength = academyLeagueTeamStrength(key);
    round.forEach(([homeId, awayId]) => {
      const homeStrength = homeId === 'me' ? myStrength : league.teams[homeId].strength;
      const awayStrength = awayId === 'me' ? myStrength : league.teams[awayId].strength;
      const [hg, ag] = simulateMatch(homeStrength, awayStrength);
      applyMatchToStandings(league.standings, homeId, awayId, hg, ag);
      if (homeId === 'me' || awayId === 'me') {
        const isHome = homeId === 'me';
        const myGoals = isHome ? hg : ag;
        const oppGoals = isHome ? ag : hg;
        const oppName = isHome ? league.teams[awayId].name : league.teams[homeId].name;
        const result = myGoals > oppGoals ? 'win' : myGoals === oppGoals ? 'draw' : 'lose';
        if (!league.myMatchLog) league.myMatchLog = [];
        league.myMatchLog.push({ round: league.currentRound + 1, isHome, oppName, myGoals, oppGoals, result });
      }
    });
    resolveAcademyCupWeek(key, league.currentRound);
    league.currentRound++;
    if (league.currentRound >= league.fixtures.length) {
      endAcademyLeagueSeason(key, league);
    }
  });
}

// 下部組織リーグのシーズン終了処理: 昇格/降格を判定し、次シーズンを即座に開始する。
// U-12を含め、どのカテゴリも単純な昇格降格のみで特別な合流処理は行わない。
function endAcademyLeagueSeason(key, league) {
  const tier = tierMetaForKey(key, league.tier);
  const table = buildLeagueSortedTable(league);
  const totalTeams = table.length;
  const myPosition = table.findIndex(t => t.id === 'me') + 1;
  const maxIdx = academyLeagueMaxTierIdx(key);

  let nextTierIdx = league.tier;
  if (tier.promote > 0 && myPosition <= tier.promote && league.tier < maxIdx) {
    nextTierIdx += 1;
  } else if (tier.relegate > 0 && myPosition > (totalTeams - tier.relegate) && league.tier > 0) {
    nextTierIdx -= 1;
  }

  startAcademyLeagueSeason(key, nextTierIdx);
}

// ---------- カップ戦 ----------
// 4種類のカップ戦(リーグカップ/ワールドピラミッドカップ/大陸カップ/ワールドクラブカップ)は
// すべてリーグ戦の節に沿って「該当する週が来たら1ラウンドずつ」消化する。これによりリーグ戦と
// カップ戦が同じ週に重なる過密日程が生まれ、コンディション(疲労)を踏まえた選手層の厚みが
// 実際に問われるようになる。特に上位ティアのクラブほど出場するカップの数が増えていく
// (大陸カップ/ワールドクラブカップはクラブランクが高いクラブだけの出場権)ため、強豪クラブ
// ほど日程が過密になりやすい。組み合わせ・スコア・進出状況はstate.leagueCup / state.worldCup /
// state.continentalCup / state.worldClubCupに保存して「カップ戦」タブでいつでも振り返れるようにする。

// PK戦: 通常時間で決着がつかなかった場合、戦力差をもとにした確率で勝者を決める
// (完全な五分五分にはせず、戦力が高い方が僅かに有利になるようにする)。
function decideCupPenalties(teamA, teamB) {
  const diff = teamA.strength - teamB.strength;
  const pA = clamp(0.5 + diff * 0.01, 0.15, 0.85);
  return Math.random() < pA ? teamA : teamB;
}

function simulateCupMatch(teamA, teamB) {
  const [homeGoals, awayGoals] = simulateMatch(teamA.strength, teamB.strength);
  let winner, penalties = false;
  if (homeGoals === awayGoals) {
    penalties = true;
    winner = decideCupPenalties(teamA, teamB);
  } else {
    winner = homeGoals > awayGoals ? teamA : teamB;
  }
  return { id: uid(), home: teamA, away: teamB, homeGoals, awayGoals, winner, penalties };
}

function shuffleTeams(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// target===1の勝ち上がり(決勝トーナメント)は準々決勝/準決勝/決勝の呼称を、それ以外
// (target===4、ワールドピラミッドカップの各ティアステージ)は単純に「第n回戦」とする。
function knockoutRoundLabel(roundIdx, nAfter, target) {
  if (target === 1) {
    if (nAfter === 1) return '決勝';
    if (nAfter === 2) return '準決勝';
    if (nAfter === 4) return '準々決勝';
  }
  return `第${roundIdx + 1}回戦`;
}

// 1ラウンドぶんだけを消化する処理単位。target(最終的な勝ち残り目標数)を基準に、このラウンドで
// 何試合組むかを決める。refreshMe=trueのときは、'me'が対戦する直前に現在のコンディションを
// 踏まえた戦力を取り直し(playMyTopMatch())、出場による消耗もこのタイミングで適用する。
function runKnockoutRoundOnce(current, target, refreshMe) {
  const n = current.length;
  const matchCount = Math.min(Math.floor(n / 2), n - target);
  shuffleTeams(current);
  const matches = [];
  const nextRound = [];
  for (let i = 0; i < matchCount; i++) {
    const a = current[i * 2], b = current[i * 2 + 1];
    if (refreshMe) {
      if (a.id === 'me') a.strength = playMyTopMatch();
      if (b.id === 'me') b.strength = playMyTopMatch();
    }
    const result = simulateCupMatch(a, b);
    if (refreshMe && (a.id === 'me' || b.id === 'me')) {
      const meIsHome = a.id === 'me';
      const myGoals = meIsHome ? result.homeGoals : result.awayGoals;
      const oppGoals = meIsHome ? result.awayGoals : result.homeGoals;
      const oppName = meIsHome ? result.away.name : result.home.name;
      const events = generateTopMatchEvents(lastPlayedXI, myGoals, oppGoals, oppName, turfLevel());
      const resultTag = myGoals > oppGoals ? 'win' : myGoals === oppGoals ? 'draw' : 'lose';
      applyTopMatchEventConsequences(events, lastPlayedXI, resultTag);
      result.meDetail = {
        isHome: meIsHome, oppName, myGoals, oppGoals, result: resultTag, events,
        penalties: result.penalties, wonPenalties: result.penalties && result.winner.id === 'me',
      };
    }
    matches.push(result);
    nextRound.push(result.winner);
  }
  const byes = current.slice(matchCount * 2);
  byes.forEach(t => nextRound.push(t));
  return { round: { sizeBefore: n, matches, byes }, nextCurrent: nextRound };
}

// teamsをtarget人数まで、単純トーナメント(1試合1敗退)で勝ち抜かせる。奇数が出た場合の
// 余りチームは自動的に「不戦勝(bye)」としてそのまま勝ち上がらせる(組み合わせは毎ラウンド
// シャッフルするため、不戦勝が特定チームに偏り続けることはない)。opts.refreshMeを渡すと、
// 'me'が実際に対戦するたびにコンディションを消耗する。カップ戦は基本的に1ラウンドずつ
// (resolveScheduledCupWeek/resolveWorldCupRound)呼び出すが、自クラブが関与しない事前処理
// (initWorldCup)や敗退後の残りラウンド一括消化(fastForwardWorldCup)ではrefreshMe=falseで
// 呼び、消耗させずに一気に決着させる。
function runKnockoutStage(teamsIn, target, opts) {
  const refreshMe = !!(opts && opts.refreshMe);
  let current = shuffleTeams(teamsIn.slice());
  const rounds = [];
  while (current.length > target) {
    const { round, nextCurrent } = runKnockoutRoundOnce(current, target, refreshMe);
    round.label = knockoutRoundLabel(rounds.length, nextCurrent.length, target);
    rounds.push(round);
    current = nextCurrent;
  }
  return { rounds, survivors: current };
}

// ---- リーグカップ(自クラブが所属する現ティアの20クラブによるノックアウト) ----
// 出場権の縛りはなく全ティア共通で毎シーズン開催する。対戦相手は招待枠ではなく、実際に
// 同じティアでリーグ戦を戦っている19クラブそのもの。進行(1ラウンドずつ消化)と賞金計算は
// 大陸カップ/ワールドクラブカップと共通のresolveScheduledCupWeek/applyScheduledCupRewardsを使う。

function generateLeagueCupEntrants() {
  return Object.keys(state.teams).map(id => ({
    id, name: state.teams[id].name, strength: id === 'me' ? myTopMatchStrength() : state.teams[id].strength,
  }));
}

function initLeagueCup() {
  if (!state.teams || Object.keys(state.teams).length !== TEAM_COUNT) { state.leagueCup = null; return; }
  state.leagueCup = {
    name: 'リーグカップ', tierName: TIERS[state.club.tier].name, scheduleWeeks: LEAGUE_CUP_SCHEDULE, nextIdx: 0,
    current: generateLeagueCupEntrants(),
    rounds: [], roundsWon: 0, finished: false, champion: null, myResult: null,
  };
}

// ---- ワールドピラミッドカップ(最下層ティアから最上位ティアまで貫くノックアウト) ----
// 自クラブが所属していないティアは、そのティア専用の仮想20クラブ(buildAiStrengthsで
// 生成、このカップ戦の計算にのみ使う使い捨てのクラブ)で代替する。自クラブの所属ティアの
// 回だけ、実際のリーグ(state.teams)をそのまま20クラブとして使う(=リーグ戦で戦っている
// のと同じ顔ぶれの中でカップ戦も戦う)。
function generateCupTierTeams(tierIdx) {
  if (tierIdx === state.club.tier && state.teams && Object.keys(state.teams).length === TEAM_COUNT) {
    return Object.keys(state.teams).map(id => ({
      id, name: state.teams[id].name, strength: id === 'me' ? myTopMatchStrength() : state.teams[id].strength, tierIdx,
    }));
  }
  const strengths = buildAiStrengths(TIER_BASELINE[tierIdx], TEAM_COUNT, TIER_HALF_WIDTH[tierIdx]);
  const usedNames = new Set();
  const list = strengths.map((strength, i) => {
    let name;
    do { name = genClubName(); } while (usedNames.has(name));
    usedNames.add(name);
    return { id: `wc${tierIdx}_${i}`, name, strength, tierIdx };
  });
  RIVAL_CLUBS.filter(r => r.tiers.top === tierIdx).forEach((rival, i) => {
    if (!list[i]) return;
    list[i] = { ...list[i], name: rival.name, strength: rivalStrength(rival, 'top'), rivalId: rival.id };
  });
  return list;
}

// 最下層ティア(0)の20クラブから4クラブが勝ち上がり、1つ上のティアの20クラブと合流して
// また4クラブが勝ち上がる…という形を最上位ティアまで繰り返し、最後に残った4クラブで
// 準決勝・決勝を行って優勝を決める。自クラブは所属ティアのステージから登場し、
// 勝ち進むほど上位ティアのクラブとも戦うことになる(下位ティアからの下剋上ストーリー)。
//
// 自クラブより下位のティアは自クラブに一切関与しないため、シーズン開始時に即座に決着させ、
// 自クラブが登場するティアへ持ち越すcarry(4クラブ)だけを確定させる(initWorldCup)。
// 自クラブの所属ティア以降はresolveWorldCupWeek()がリーグ戦の節に合わせて1ラウンドずつ
// 消化していく(=そこから先が実際に自クラブの日程を圧迫する)。自クラブが敗退した瞬間、
// それ以降は日程を圧迫する意味がなくなるため、残りは即座に最後まで一括消化する
// (fastForwardWorldCup)。

function initWorldCup() {
  const myTier = state.club.tier;
  const stages = [];
  let carry = [];
  for (let t = 0; t < myTier; t++) {
    const entrants = generateCupTierTeams(t);
    const { rounds, survivors } = runKnockoutStage(entrants, 4, {});
    stages.push({ tierIdx: t, tierName: TIERS[t].name, rounds, winners: survivors, meEntered: false });
    carry = survivors;
  }
  const entrants = [...carry, ...generateCupTierTeams(myTier)];
  state.worldCup = {
    stages,
    activeStage: { tierIdx: myTier, entrants, current: entrants, rounds: [], meEntered: true },
    finalStage: null,
    stagesWonTotal: 0, tiersCleared: 0, eliminatedAt: null,
    finished: false, champion: null, myResult: null,
  };
}

// 1ステージ(target=4への勝ち上がり)が完了した際に呼ぶ: 完了したステージをstate.worldCup.stages
// へ記録し、次のティアがあればその20クラブと合流させた新しいステージへ、なければ決勝ステージ
// (最後に残った4クラブでの準決勝・決勝、target=1)へ進める。
function advanceWorldCupStage(cup) {
  const finished = cup.activeStage;
  if (finished.meEntered && finished.current.some(t => t.id === 'me')) cup.tiersCleared++;
  cup.stages.push({ tierIdx: finished.tierIdx, tierName: TIERS[finished.tierIdx].name, rounds: finished.rounds, winners: finished.current, meEntered: finished.meEntered });
  if (finished.tierIdx + 1 < TIERS.length) {
    const nextEntrants = [...finished.current, ...generateCupTierTeams(finished.tierIdx + 1)];
    cup.activeStage = { tierIdx: finished.tierIdx + 1, entrants: nextEntrants, current: nextEntrants, rounds: [], meEntered: nextEntrants.some(e => e.id === 'me') };
  } else {
    cup.activeStage = null;
    cup.finalStage = { rounds: [], current: finished.current };
  }
}

// activeStage(またはfinalStage)を1ラウンドぶんだけ消化する。目標人数に到達したら次の
// ステージへ自動的に進む(決勝が1クラブに到達したら優勝確定)。
function resolveWorldCupRound(cup, refreshMe) {
  const stage = cup.activeStage || cup.finalStage;
  const target = cup.activeStage ? 4 : 1;
  const { round, nextCurrent } = runKnockoutRoundOnce(stage.current, target, refreshMe);
  round.label = knockoutRoundLabel(stage.rounds.length, nextCurrent.length, target);
  stage.rounds.push(round);
  stage.current = nextCurrent;
  const meMatch = round.matches.find(m => m.home.id === 'me' || m.away.id === 'me');
  const wasIn = !!meMatch;
  const stillIn = nextCurrent.some(t => t.id === 'me');
  if (wasIn) {
    if (stillIn) cup.stagesWonTotal += 1;
    else cup.eliminatedAt = { tierIdx: cup.activeStage ? cup.activeStage.tierIdx : 'final', roundLabel: round.label };
  }
  if (nextCurrent.length === target) {
    if (cup.activeStage) {
      advanceWorldCupStage(cup);
    } else {
      cup.finished = true;
      cup.champion = nextCurrent[0];
      cup.myResult = { stagesWonTotal: cup.stagesWonTotal, tiersCleared: cup.tiersCleared, eliminatedAt: cup.eliminatedAt, champion: cup.champion.id === 'me' };
      applyWorldCupRewards(cup.myResult);
    }
  }
  return { wasIn, stillIn, meDetail: meMatch ? meMatch.meDetail : null };
}

function fastForwardWorldCup(cup) {
  while (!cup.finished) resolveWorldCupRound(cup, false);
}

// 現在の節番号がWORLD_CUP_START_WEEK以降・WORLD_CUP_CADENCE間隔に乗っていれば、進行中の
// ステージ/決勝を1ラウンドぶん消化する。自クラブが敗退した瞬間、残りは即座に最後まで
// 消化して以降の節を空ける。
function resolveWorldCupWeek() {
  const cup = state.worldCup;
  if (!cup || cup.finished) return null;
  if (state.currentRound < WORLD_CUP_START_WEEK || (state.currentRound - WORLD_CUP_START_WEEK) % WORLD_CUP_CADENCE !== 0) return null;
  const { wasIn, stillIn, meDetail } = resolveWorldCupRound(cup, true);
  if (wasIn && !stillIn) fastForwardWorldCup(cup);
  return meDetail;
}

// リーグカップよりさらに規模の大きい賞金・評判ボーナス。「1勝あたり」に加えて
// 「ティアステージを突破するたび」にもボーナスを積み増し、下位ティアから勝ち上がるほど
// 大きな成果として報われるようにする。優勝(全ティア制覇)は一発逆転級の特別ボーナス。
function applyWorldCupRewards(myResult) {
  const econSqrt = Math.sqrt(TIERS[state.club.tier].econ);
  // 賞金基礎額はリーグ戦と同じく旧来の6倍に引き上げ済み(普段の週間収入との釣り合いを取るため)。
  let prize = Math.round(myResult.stagesWonTotal * 120 * econSqrt) + Math.round(myResult.tiersCleared * 600 * econSqrt);
  let repGain = myResult.stagesWonTotal * 3 + myResult.tiersCleared * 12;
  if (myResult.champion) {
    prize += Math.round(3000 * econSqrt);
    repGain += 38;
  }
  if (prize > 0) state.club.money += prize;
  if (repGain > 0) state.club.reputation = clamp(state.club.reputation + repGain, 0, reputationCapForTier(state.club.tier));

  if (myResult.champion) {
    addLog(`🌍🏆 ワールドピラミッドカップで優勝しました！全ティアを勝ち上がっての快挙です。賞金 ${fmtMoney(prize)} ／ 評判 +${repGain}`, 'gold');
  } else if (myResult.eliminatedAt) {
    const stageLabel = myResult.eliminatedAt.tierIdx === 'final' ? '決勝ステージ' : `${TIERS[myResult.eliminatedAt.tierIdx].name}ステージ`;
    addLog(`ワールドピラミッドカップは${stageLabel}の${myResult.eliminatedAt.roundLabel}で敗退しました。(通算${myResult.stagesWonTotal}勝 ／ 賞金 ${fmtMoney(prize)})`, 'good');
  }
}

// ---- ランク別カップ(クラブランクの段階に応じて出場権が生まれる、週単位で進行するカップ) ----
// リーグカップと同じくresolveScheduledCupWeek()でリーグ戦の節に沿って「節が来るたびに
// 1ラウンドずつ」消化する。これにより、同じ週にリーグ戦とカップ戦が重なる過密日程が生まれ、
// コンディション(疲労)が実際に意味を持つ。
// 大陸カップ: クラブランク段階10(全国的強豪)以上で出場権。16クラブ・4ラウンド。
// ワールドクラブカップ: クラブランク段階16(大陸の盟主)以上で出場権。8クラブ・3ラウンド、
// 企画書2.3「各大陸王者が集う最高峰の大会」に相当する最上位カップとして、賞金・評判とも
// 大陸カップの2倍の重みを持たせる。
const CONTINENTAL_CUP_MIN_RANK_STAGE = 10;
const CONTINENTAL_CUP_SIZE = 16;
const CONTINENTAL_CUP_SCHEDULE = [4, 11, 18, 25];
const WORLD_CLUB_CUP_MIN_RANK_STAGE = 16;
const WORLD_CLUB_CUP_SIZE = 8;
const WORLD_CLUB_CUP_SCHEDULE = [7, 16, 27];
// リーグカップ: 出場権の縛りなし(全ティア共通)、自クラブが所属する20クラブによる
// ノックアウト(5ラウンド固定)。大陸カップ/ワールドクラブカップとは別の週に割り当て、
// 互いの節がずれることで「今週はカップ2つ重なる」といった過密日程が生まれるようにする。
const LEAGUE_CUP_SCHEDULE = [2, 8, 14, 20, 26];
// ワールドピラミッドカップ: 全ティアを貫く勝ち上がりのため必要ラウンド数が所属ティアや
// 勝ち上がり具合で変動する。固定の週配列ではなく「3節に1回」のペースで、自クラブが
// 在籍している限り消化し続ける(敗退したら残りは即座に一括消化するため、日程を圧迫する
// のは実際に勝ち進んでいるクラブだけになる)。
const WORLD_CUP_CADENCE = 3;
const WORLD_CUP_START_WEEK = 3;

// ---- 大陸チャンピオンズカップ(L9=大陸プレミアリーグ以上で開催される、CL方式の通期カップ) ----
// 「予選(ノックアウト)→リーグフェーズ(総当たり)→決勝トーナメント」という実際のCL方式の
// 一連の流れを再現する最上位カップ。自クラブの所属ティアがCHAMPIONS_CUP_MIN_TIER(大陸プレミア
// リーグ)に到達すると、これまでの大陸カップ(ノックアウトのみ)に代わって毎シーズン自動開催
// される(=大陸カップはCHAMPIONS_CUP_MIN_TIER未満のクラブ専用に格下げし、同格の大会が2つ
// 並行しないようにする。詳細はinitSeasonCups()を参照)。
// クラブランクが十分に高い(大陸の盟主=段階16以上)クラブは予選免除でリーグフェーズへ直接進出、
// 昇格したばかりの新興クラブは予選から勝ち上がる必要がある(実際のCLのシード configuration を模す)。
const CHAMPIONS_CUP_MIN_TIER = 8;
const CHAMPIONS_CUP_DIRECT_RANK_STAGE = 16;
const CHAMPIONS_CUP_LEAGUE_SIZE = 8;
const CHAMPIONS_CUP_QUALIFY_SIZE = 4;
// 節配分は既存カップ(リーグカップ2/8/14/20/26、大陸カップ4/11/18/25、ワールドクラブカップ
// 7/16/27、ワールドピラミッドカップ3節おき)と1節も重ならないように選定している。特に
// リーグフェーズ以降(第10節以降)は既存カップの多くが消化を終えている後半戦に厚めに配置し、
// 「開幕直後は今までどおり、終盤にCLらしい山場が来る」という緩急をつける。
const CHAMPIONS_CUP_QUALIFY_SCHEDULE = [5];
const CHAMPIONS_CUP_LEAGUE_SCHEDULE = [10, 13, 17, 19, 22, 29, 31];
const CHAMPIONS_CUP_KNOCKOUT_SCHEDULE = [34, 37];

// 対戦相手プールは、現在のティアの目安総合力(baseline)にstrengthBonusを加えた帯域から生成する
// (ランク上位クラブ同士の招待戦という位置づけのため、通常のリーグ対戦相手よりやや強めにする)。
function generateRankCupEntrants(count, strengthBonus) {
  const baseline = TIER_BASELINE[state.club.tier] + strengthBonus;
  const strengths = buildAiStrengths(baseline, count - 1, TIER_HALF_WIDTH[state.club.tier]);
  const usedNames = new Set([state.club.name]);
  const aiTeams = strengths.map((s, i) => {
    let name;
    do { name = genClubName(); } while (usedNames.has(name));
    usedNames.add(name);
    return { id: 'rc' + i, name, strength: s };
  });
  return shuffleTeams([{ id: 'me', name: state.club.name, strength: myTopMatchStrength() }, ...aiTeams]);
}

// シーズン開始のたびにカップ戦一式を組み直す。リーグカップ/ワールドピラミッドカップは
// 全ティア共通で毎シーズン開催、大陸カップ/ワールドクラブカップは現時点のクラブランクで
// 出場権があるものだけを新規に組み直す(出場権がない場合はnullにし、カップ戦タブでは
// 「出場していません」と案内する)。
function initSeasonCups() {
  initLeagueCup();
  initWorldCup();
  const rank = computeClubRank();
  // 大陸カップは大陸チャンピオンズカップ(CHAMPIONS_CUP_MIN_TIER=大陸プレミアリーグ以上で開催)
  // に役割を引き継ぐため、そのティアに到達したクラブは対象外にする(同格の大会が2つ並行して
  // 日程を圧迫しないようにするための調整)。
  state.continentalCup = (rank.stage >= CONTINENTAL_CUP_MIN_RANK_STAGE && state.club.tier < CHAMPIONS_CUP_MIN_TIER) ? {
    name: '大陸カップ', scheduleWeeks: CONTINENTAL_CUP_SCHEDULE, nextIdx: 0,
    current: generateRankCupEntrants(CONTINENTAL_CUP_SIZE, 10),
    rounds: [], roundsWon: 0, finished: false, champion: null, myResult: null,
  } : null;
  state.worldClubCup = rank.stage >= WORLD_CLUB_CUP_MIN_RANK_STAGE ? {
    name: 'ワールドクラブカップ', scheduleWeeks: WORLD_CLUB_CUP_SCHEDULE, nextIdx: 0,
    current: generateRankCupEntrants(WORLD_CLUB_CUP_SIZE, 20),
    rounds: [], roundsWon: 0, finished: false, champion: null, myResult: null,
  } : null;
  initChampionsCup();
}

// 現在の節番号(state.currentRound)がこのカップの次の予定週と一致していれば、1ラウンドだけ
// 消化する。まだ順番が来ていない/既に終了している場合は何もしない。リーグカップ/大陸カップ/
// ワールドクラブカップの3つはこの共通処理で消化する(ワールドピラミッドカップだけはティアを
// またぐ複雑な進行のため専用のresolveWorldCupWeek()を使う)。
function resolveScheduledCupWeek(cup, scale) {
  if (!cup || cup.finished || !cup.scheduleWeeks) return null;
  if (cup.scheduleWeeks[cup.nextIdx] !== state.currentRound) return null;
  cup.nextIdx++;
  const { round, nextCurrent } = runKnockoutRoundOnce(cup.current, 1, true);
  round.label = knockoutRoundLabel(cup.rounds.length, nextCurrent.length, 1);
  cup.rounds.push(round);
  cup.current = nextCurrent;
  const meMatch = round.matches.find(m => m.home.id === 'me' || m.away.id === 'me');
  const wasIn = !!meMatch;
  const stillIn = nextCurrent.some(t => t.id === 'me');
  if (wasIn) {
    if (stillIn) cup.roundsWon += 1;
    else cup.myResult = { champion: false, roundLabel: round.label };
  }
  if (nextCurrent.length === 1) {
    cup.finished = true;
    cup.champion = nextCurrent[0];
    if (cup.champion.id === 'me') cup.myResult = { champion: true, roundLabel: null };
    applyScheduledCupRewards(cup, scale);
  }
  return meMatch ? meMatch.meDetail : null;
}

// 賞金・評判は勝ち上がった回数に応じて逓増し、優勝時は追加ボーナス。scaleでリーグカップ
// (0.6倍)・大陸カップ(1倍)・ワールドクラブカップ(2倍)の重みを差別化する。
function applyScheduledCupRewards(cup, scale) {
  const econSqrt = Math.sqrt(TIERS[state.club.tier].econ);
  // 賞金基礎額はリーグ戦と同じく旧来の6倍に引き上げ済み(普段の週間収入との釣り合いを取るため)。
  let prize = Math.round(cup.roundsWon * 150 * econSqrt * scale);
  let repGain = Math.round(cup.roundsWon * 3 * scale);
  if (cup.myResult && cup.myResult.champion) {
    prize += Math.round(1200 * econSqrt * scale);
    repGain += Math.round(23 * scale);
  }
  if (prize > 0) state.club.money += prize;
  if (repGain > 0) state.club.reputation = clamp(state.club.reputation + repGain, 0, reputationCapForTier(state.club.tier));

  if (cup.myResult && cup.myResult.champion) {
    addLog(`🏆 ${cup.name}で優勝しました！ 賞金 ${fmtMoney(prize)} ／ 評判 +${repGain}`, 'gold');
  } else if (cup.roundsWon > 0) {
    addLog(`${cup.name}は${cup.myResult.roundLabel}で敗退しました。(${cup.roundsWon}回戦突破 ／ 賞金 ${fmtMoney(prize)})`, 'good');
  } else {
    addLog(`${cup.name}は${cup.myResult ? cup.myResult.roundLabel : '初戦'}で敗退しました。`, 'bad');
  }
}

// ---- 下部組織カップ(2軍以下/ユース以下、リーグ単位の新規カップ戦) ----
// トップの「リーグカップ」と同じ汎用ノックアウトエンジン(runKnockoutRoundOnce/simulateCupMatch/
// knockoutRoundLabel、いずれも無改造で流用)・同じ日程(LEAGUE_CUP_SCHEDULE)で、下部組織リーグ
// 1つにつき1つのノックアウトカップを開催する。2〜5軍はトップと表を共有しうる(=対戦相手の
// 顔ぶれが毎シーズン変わる)ため、カップの対戦相手はリーグの顔ぶれを流用せず、
// academyBaselineForTier基準で独自にAIプールを生成する(下部組織の試合は現状イベント詳細
// (meDetail)を持たないため、runKnockoutRoundOnceはrefreshMe=falseで呼び、'me'の戦力だけ
// 毎回academyLeagueTeamStrength(key)で取り直す。トップ専用のplayMyTopMatch()は使わない)。
// シーズンごとに毎回組み直す(下部組織リーグの新設・昇格降格・再参戦のたびに1回開催)。
function initAcademyCup(key, tierIdx) {
  const cat = ACADEMY_LEAGUE_CATEGORY[key];
  const baseline = academyBaselineForTier(cat, tierIdx);
  const strengths = buildAiStrengths(baseline, TEAM_COUNT - 1, TIER_HALF_WIDTH[tierIdx]);
  const myName = `${state.club.name}${TEAM_NAME_SUFFIX[key]}`;
  const usedNames = new Set([myName]);
  const current = [{ id: 'me', name: myName, strength: 0 }];
  for (let i = 0; i < TEAM_COUNT - 1; i++) {
    let name;
    do { name = `${genClubName()}${TEAM_NAME_SUFFIX[key]}`; } while (usedNames.has(name));
    usedNames.add(name);
    current.push({ id: 'ai' + i, name, strength: strengths[i] });
  }
  state.club.academyCups[key] = {
    name: `${academyLeagueLabel(key)}カップ`, tierName: tierNamesForKey(key)[tierIdx], tierIdx,
    scheduleWeeks: LEAGUE_CUP_SCHEDULE, nextIdx: 0,
    current,
    rounds: [], roundsWon: 0, finished: false, champion: null, myResult: null,
  };
}

// リーグの節消化ごとに1回呼ぶ。roundIdx(消化前の節番号。2〜5軍はstate.currentRound、
// ユース以下はそのリーグ自身のcurrentRound)がscheduleWeeksの次の予定と一致していれば
// 1ラウンドだけ消化する。
function resolveAcademyCupWeek(key, roundIdx) {
  const cup = state.club.academyCups[key];
  if (!cup || cup.finished || !cup.scheduleWeeks) return;
  if (cup.scheduleWeeks[cup.nextIdx] !== roundIdx) return;
  cup.nextIdx++;
  const meEntry = cup.current.find(t => t.id === 'me');
  if (meEntry) meEntry.strength = academyLeagueTeamStrength(key);
  const { round, nextCurrent } = runKnockoutRoundOnce(cup.current, 1, false);
  round.label = knockoutRoundLabel(cup.rounds.length, nextCurrent.length, 1);
  cup.rounds.push(round);
  cup.current = nextCurrent;
  const meMatch = round.matches.find(m => m.home.id === 'me' || m.away.id === 'me');
  const wasIn = !!meMatch;
  const stillIn = nextCurrent.some(t => t.id === 'me');
  if (wasIn) {
    if (stillIn) cup.roundsWon += 1;
    else cup.myResult = { champion: false, roundLabel: round.label };
  }
  if (nextCurrent.length === 1) {
    cup.finished = true;
    cup.champion = nextCurrent[0];
    if (cup.champion.id === 'me') cup.myResult = { champion: true, roundLabel: null };
    applyAcademyCupRewards(cup, cup.tierIdx);
  }
}

// 下部組織カップの賞金・評判はトップの各種カップ(applyScheduledCupRewards、econベース)より
// 意図的に控えめな固定スケールにする(下部組織の試合がトップの収益源を上回らないようにするため)。
// tierIdxが高いほど(上位リーグほど)やや上乗せする簡易な調整に留める。
function applyAcademyCupRewards(cup, tierIdx) {
  const tierMult = tierIdx + 1;
  let prize = cup.roundsWon * 15 * tierMult;
  let repGain = cup.roundsWon * 2;
  if (cup.myResult && cup.myResult.champion) {
    prize += 120 * tierMult;
    repGain += 15;
  }
  if (prize > 0) state.club.money += prize;
  if (repGain > 0) state.club.reputation = clamp(state.club.reputation + repGain, 0, reputationCapForTier(state.club.tier));

  if (cup.myResult && cup.myResult.champion) {
    addLog(`🏆 ${cup.name}で優勝しました！ 賞金 ${fmtMoney(prize)} ／ 評判 +${repGain}`, 'gold');
  } else if (cup.roundsWon > 0) {
    addLog(`${cup.name}は${cup.myResult.roundLabel}で敗退しました。(${cup.roundsWon}回戦突破 ／ 賞金 ${fmtMoney(prize)})`, 'good');
  } else {
    addLog(`${cup.name}は${cup.myResult ? cup.myResult.roundLabel : '初戦'}で敗退しました。`, 'bad');
  }
}

// ---- 大陸チャンピオンズカップ本体 ----
// 対戦相手プール生成: generateRankCupEntrantsと同様の帯域生成だが、予選プール/直接出場プールを
// 別々に用意する必要があるため専用の関数にする(usedNamesを呼び出し側で共有し、名前重複を防ぐ)。
function generateChampionsCupPool(count, strengthBonus, usedNames, idPrefix) {
  if (count <= 0) return [];
  const baseline = TIER_BASELINE[state.club.tier] + strengthBonus;
  const strengths = buildAiStrengths(baseline, count, TIER_HALF_WIDTH[state.club.tier]);
  return strengths.map((s, i) => {
    let name;
    do { name = genClubName(); } while (usedNames.has(name));
    usedNames.add(name);
    return { id: `${idPrefix}${i}`, name, strength: s };
  });
}

// シーズン開始時に組む: 直接出場6クラブ+予選4クラブ(うち2クラブがリーグフェーズへ勝ち上がる)。
// 自クラブのクラブランクが基準(大陸の盟主=段階16)以上なら直接出場側、未満なら予選側に入る。
function initChampionsCup() {
  if (state.club.tier < CHAMPIONS_CUP_MIN_TIER) { state.champCup = null; return; }
  const usedNames = new Set([state.club.name]);
  const meDirect = clubRankStage() >= CHAMPIONS_CUP_DIRECT_RANK_STAGE;
  const directCount = CHAMPIONS_CUP_LEAGUE_SIZE - CHAMPIONS_CUP_QUALIFY_SIZE / 2; // 8 - 2 = 6
  const meEntry = { id: 'me', name: state.club.name, strength: myTopMatchStrength() };
  const directPool = generateChampionsCupPool(meDirect ? directCount - 1 : directCount, 24, usedNames, 'ccd');
  const qualifyPool = generateChampionsCupPool(meDirect ? CHAMPIONS_CUP_QUALIFY_SIZE : CHAMPIONS_CUP_QUALIFY_SIZE - 1, 6, usedNames, 'ccq');
  const directTeams = meDirect ? shuffleTeams([meEntry, ...directPool]) : directPool;
  const qualifyTeams = meDirect ? qualifyPool : shuffleTeams([meEntry, ...qualifyPool]);

  state.champCup = {
    name: '大陸チャンピオンズカップ',
    phase: 'qualify',
    meDirect,
    qualifyTeams, qualifyRound: null,
    directTeams,
    leagueTeams: null, leagueFixtures: null, leagueRound: 0, standings: null, leagueLog: [], leagueTable: null, myGroupPosition: null,
    knockoutCurrent: null, knockoutRounds: [], knockoutIdx: 0,
    stagesWonTotal: 0, eliminatedAt: null,
    finished: false, champion: null, myResult: null,
  };
}

// リーグフェーズ開始: 予選を勝ち上がった2クラブ(または自クラブが予選不参加の場合はそのまま)と
// 直接出場6クラブを合流させ、8クラブの1回総当たり(7節)を組む。
function startChampionsCupLeaguePhase(cup, qualifiedTeams) {
  const allTeams = [...cup.directTeams, ...qualifiedTeams];
  const teams = {};
  allTeams.forEach(t => { teams[t.id] = { name: t.name, strength: t.id === 'me' ? null : t.strength }; });
  const standings = {};
  Object.keys(teams).forEach(id => { standings[id] = { played: 0, win: 0, draw: 0, lose: 0, gf: 0, ga: 0, pts: 0 }; });
  cup.leagueTeams = teams;
  cup.standings = standings;
  cup.leagueFixtures = generateRoundRobin(Object.keys(teams));
  cup.leagueRound = 0;
  cup.phase = 'league';
}

// 節が来るたびに1節ぶんだけ消化する(リーグ戦の各節と同じ粒度)。トップチームの実効戦力・
// コンディション消耗・観戦イベントは、リーグ戦本体(simulateOneRound)と同じ扱いにする。
function resolveChampionsCupLeagueRound(cup) {
  const round = cup.leagueFixtures[cup.leagueRound];
  let meDetail = null;
  round.forEach(([homeId, awayId]) => {
    const homeStrength = homeId === 'me' ? playMyTopMatch() : cup.leagueTeams[homeId].strength;
    const awayStrength = awayId === 'me' ? playMyTopMatch() : cup.leagueTeams[awayId].strength;
    const [hg, ag] = simulateMatch(homeStrength, awayStrength);
    applyMatchToStandings(cup.standings, homeId, awayId, hg, ag);
    if (homeId === 'me' || awayId === 'me') {
      const isHome = homeId === 'me';
      const myGoals = isHome ? hg : ag;
      const oppGoals = isHome ? ag : hg;
      const oppName = isHome ? cup.leagueTeams[awayId].name : cup.leagueTeams[homeId].name;
      const result = myGoals > oppGoals ? 'win' : myGoals === oppGoals ? 'draw' : 'lose';
      const events = generateTopMatchEvents(lastPlayedXI, myGoals, oppGoals, oppName, turfLevel());
      applyTopMatchEventConsequences(events, lastPlayedXI, result);
      meDetail = { isHome, oppName, myGoals, oppGoals, result, events, competition: '大陸チャンピオンズカップ', round: cup.leagueRound + 1 };
      cup.leagueLog.push(meDetail);
    }
  });
  cup.leagueRound++;
  if (cup.leagueRound >= cup.leagueFixtures.length) finishChampionsCupLeaguePhase(cup);
  return meDetail;
}

// リーグフェーズ終了: 上位4クラブが決勝トーナメントへ進出。自クラブが4位以内でなければ
// (=決勝トーナメント進出を逃せば)そこでカップ終了。以降のブラケットは日程を圧迫しないよう
// 即座に一括消化し、優勝クラブの記録だけ残す(ワールドピラミッドカップと同じ設計)。
function finishChampionsCupLeaguePhase(cup) {
  const table = buildLeagueSortedTable({ teams: cup.leagueTeams, standings: cup.standings });
  cup.leagueTable = table;
  cup.myGroupPosition = table.findIndex(t => t.id === 'me') + 1;
  const top4 = table.slice(0, 4).map(row => ({
    id: row.id, name: row.name,
    strength: row.id === 'me' ? myTopMatchStrength() : cup.leagueTeams[row.id].strength,
  }));
  if (!top4.some(t => t.id === 'me')) {
    cup.finished = true;
    cup.eliminatedAt = { stage: 'league', position: cup.myGroupPosition };
    cup.myResult = { stage: 'league', champion: false };
    const { survivors } = runKnockoutStage(top4, 1, {});
    cup.champion = survivors[0];
    applyChampionsCupRewards(cup);
    return;
  }
  cup.phase = 'knockout';
  cup.knockoutCurrent = top4;
}

// 決勝トーナメント(準決勝→決勝の2ラウンド)を1節ぶんだけ消化する。自クラブが敗退した瞬間、
// 残りは即座に消化して優勝クラブを確定させる(以降の節は圧迫しない)。
function resolveChampionsCupKnockoutRound(cup) {
  const target = cup.knockoutCurrent.length > 2 ? 2 : 1;
  const { round, nextCurrent } = runKnockoutRoundOnce(cup.knockoutCurrent, target, true);
  round.label = target === 1 ? '決勝' : '準決勝';
  cup.knockoutRounds.push(round);
  cup.knockoutCurrent = nextCurrent;
  cup.knockoutIdx++;
  const meMatch = round.matches.find(m => m.home.id === 'me' || m.away.id === 'me');
  const wasIn = !!meMatch;
  const stillIn = nextCurrent.some(t => t.id === 'me');
  if (wasIn) {
    if (stillIn) cup.stagesWonTotal += 1;
    else cup.eliminatedAt = { stage: 'knockout', roundLabel: round.label };
  }
  if (nextCurrent.length === 1) {
    cup.finished = true;
    cup.champion = nextCurrent[0];
    cup.myResult = { stage: 'knockout', champion: nextCurrent[0].id === 'me' };
    applyChampionsCupRewards(cup);
  } else if (wasIn && !stillIn) {
    cup.finished = true;
    cup.myResult = { stage: 'knockout', champion: false };
    const { survivors } = runKnockoutStage(nextCurrent, 1, {});
    cup.champion = survivors[0];
    applyChampionsCupRewards(cup);
  }
  return meMatch ? meMatch.meDetail : null;
}

// 節が来るたびに、現在のフェーズ(予選/リーグフェーズ/決勝トーナメント)に応じて1回だけ消化する。
// リーグ戦の他の節処理(simulateOneRound)から毎節呼ばれ、該当する節でなければ何もしない。
function resolveChampionsCupWeek() {
  const cup = state.champCup;
  if (!cup || cup.finished) return null;
  const week = state.currentRound;
  if (cup.phase === 'qualify') {
    if (CHAMPIONS_CUP_QUALIFY_SCHEDULE[0] !== week) return null;
    const { round, nextCurrent } = runKnockoutRoundOnce(cup.qualifyTeams, CHAMPIONS_CUP_QUALIFY_SIZE / 2, true);
    round.label = '予選';
    cup.qualifyRound = round;
    const meMatch = round.matches.find(m => m.home.id === 'me' || m.away.id === 'me');
    const wasIn = !!meMatch;
    const stillIn = nextCurrent.some(t => t.id === 'me');
    if (wasIn && !stillIn) {
      cup.finished = true;
      cup.eliminatedAt = { stage: 'qualify' };
      cup.myResult = { stage: 'qualify', champion: false };
      applyChampionsCupRewards(cup);
      return meMatch.meDetail;
    }
    startChampionsCupLeaguePhase(cup, nextCurrent);
    return meMatch ? meMatch.meDetail : null;
  }
  if (cup.phase === 'league') {
    const idx = cup.leagueRound;
    if (CHAMPIONS_CUP_LEAGUE_SCHEDULE[idx] !== week) return null;
    return resolveChampionsCupLeagueRound(cup);
  }
  if (cup.phase === 'knockout') {
    const idx = cup.knockoutIdx;
    if (CHAMPIONS_CUP_KNOCKOUT_SCHEDULE[idx] !== week) return null;
    return resolveChampionsCupKnockoutRound(cup);
  }
  return null;
}

// 賞金・評判はリーグフェーズの勝敗+決勝トーナメントの勝ち上がりに応じて逓増し、優勝時は
// 別格の特別ボーナス。ワールドクラブカップ(scale=2)に次ぐ格として、大陸カップ(scale=1)より
// 一段重い重みにする。
function applyChampionsCupRewards(cup) {
  const econSqrt = Math.sqrt(TIERS[state.club.tier].econ);
  const leagueWins = cup.leagueLog.filter(m => m.result === 'win').length;
  const leagueDraws = cup.leagueLog.filter(m => m.result === 'draw').length;
  const knockoutWins = cup.stagesWonTotal;
  const reachedKnockout = cup.myGroupPosition != null && cup.myGroupPosition <= 4;
  let prize = Math.round((leagueWins * 110 + leagueDraws * 35 + knockoutWins * 250) * econSqrt);
  let repGain = leagueWins * 2 + knockoutWins * 6;
  if (reachedKnockout) { prize += Math.round(600 * econSqrt); repGain += 9; }
  if (cup.myResult && cup.myResult.champion) {
    prize += Math.round(4500 * econSqrt);
    repGain += 45;
  }
  if (prize > 0) state.club.money += prize;
  if (repGain > 0) state.club.reputation = clamp(state.club.reputation + repGain, 0, reputationCapForTier(state.club.tier));

  if (cup.myResult && cup.myResult.champion) {
    addLog(`🌟🏆 ${cup.name}で優勝しました！大陸の頂点に立つ快挙です。賞金 ${fmtMoney(prize)} ／ 評判 +${repGain}`, 'gold');
  } else if (cup.eliminatedAt && cup.eliminatedAt.stage === 'qualify') {
    addLog(`${cup.name}は予選で敗退しました。`, 'bad');
  } else if (cup.eliminatedAt && cup.eliminatedAt.stage === 'league') {
    addLog(`${cup.name}はリーグフェーズ${cup.eliminatedAt.position}位で決勝トーナメント進出を逃しました。(賞金 ${fmtMoney(prize)})`, 'good');
  } else if (cup.eliminatedAt) {
    addLog(`${cup.name}は${cup.eliminatedAt.roundLabel}で敗退しました。(賞金 ${fmtMoney(prize)})`, 'good');
  }
}

function endSeason() {
  // 今シーズン使われたadultLeagues全エントリ(トップの所属ティアだけでなく、トップと
  // 同居していない2〜5軍の別ティアぶんも含む)を1つずつ処理し、中に含まれる自チームid
  // (トップ='me'、2〜5軍='me_reserve'等)それぞれの昇格/降格を判定する。トップぶん
  // (賞金・評判・クラブランク条件つき昇格)は下記の変数に集約し、このあとの成長・引退処理・
  // シーズンレビュー組み立てで従来どおり使う。2〜5軍ぶんは賞金・評判は無く(下部組織は
  // これまでも無かったため一貫性がある)、state.club.reserveTier[key]の更新のみ行う。
  let table, totalTeams, myPosition, prize, tierName;
  let promoted = false, relegated = false;
  Object.keys(state.club.adultLeagues).forEach(tierStr => {
    const tierIdx = Number(tierStr);
    const adultLeague = state.club.adultLeagues[tierIdx];
    const tierMeta = TIERS[tierIdx];
    const tbl = buildLeagueSortedTable(adultLeague);
    const total = tbl.length;
    adultLeague.memberKeys.forEach(key => {
      const idx = tbl.findIndex(t => t.id === adultIdForKey(key));
      const pos = idx + 1;
      if (key === 'top') {
        table = tbl; totalTeams = total; myPosition = pos; tierName = tierMeta.name;
        prize = tierMeta.prizePool[idx] || 0;
        state.club.money += prize;
        state.club.reputation = clamp(state.club.reputation + repDeltaForPosition(pos, total), 0, reputationCapForTier(state.club.tier));
        if (tierMeta.promote > 0 && pos <= tierMeta.promote && state.club.tier < TIERS.length - 1) {
          // 順位が昇格圏内でも、クラブランクが基準の段階に届いていなければ昇格を見送る
          // (企画書2.2「大陸以上は成績+クラブランクが必要」の反映)。
          const rank = computeClubRank();
          const requiredStage = TIER_PROMOTION_MIN_RANK_STAGE[state.club.tier];
          if (rank.stage >= requiredStage) {
            state.club.tier += 1;
            promoted = true;
            // 昇格ボーナスはreputationCapForTier()の上昇幅(+100)より小さくし、新しいティア内でも
            // 好成績やスポンサー契約でさらに評判を伸ばす余地を残す。
            state.club.reputation = clamp(state.club.reputation + 30, 0, reputationCapForTier(state.club.tier));
          } else {
            addLog(`順位は昇格圏内でしたが、クラブランクが基準(${CLUB_RANK_STAGES[requiredStage].label})に届かず昇格を見送りました。(現在のクラブランク: ${rank.label})`, 'gold');
          }
        } else if (tierMeta.relegate > 0 && pos > (total - tierMeta.relegate) && state.club.tier > 0) {
          state.club.tier -= 1;
          relegated = true;
          state.club.reputation = clamp(state.club.reputation - 30, 0, reputationCapForTier(state.club.tier));
        }
      } else {
        const maxIdx = academyLeagueMaxTierIdx(key);
        let nextTier = state.club.reserveTier[key];
        if (tierMeta.promote > 0 && pos <= tierMeta.promote && nextTier < maxIdx) nextTier += 1;
        else if (tierMeta.relegate > 0 && pos > (total - tierMeta.relegate) && nextTier > 0) nextTier -= 1;
        state.club.reserveTier[key] = nextTier;
      }
    });
  });

  const topGrowth = growAndAgePlayers();
  const academyGrowth = runAcademy();
  const reserveGraduation = processReserveGraduation();
  ageCoachesAndRetire();
  tickSponsorContracts();

  const grownCount = topGrowth.grownCount + academyGrowth.grownCount;
  const totalGrowth = topGrowth.totalGrowth + academyGrowth.totalGrowth;
  if (grownCount > 0) {
    addLog(`今シーズンは${grownCount}名の選手が成長しました(能力値合計 +${totalGrowth})。`, 'good');
  }

  state.lastFinalStandings = table;
  state.lastSeasonSummary = { position: myPosition, prize, promoted, relegated, tierName };
  addLog(
    `【シーズン${state.season}終了】最終順位 ${myPosition}位 / 賞金 ${fmtMoney(prize)}${promoted ? ' ✨昇格しました!' : ''}${relegated ? ' ⚠降格しました…' : ''}`,
    promoted ? 'good' : (relegated ? 'bad' : 'gold')
  );

  // クラブ記録・マイルストーン(企画書12.4): リーグ優勝回数を加算し、シーズン成績を反映して判定。
  if (myPosition === 1 && state.club.records) state.club.records.championships = (state.club.records.championships || 0) + 1;
  checkMilestones();

  // 引退選手の身の振り方(何もしない/提携クラブへコーチ斡旋/自クラブのコーチに招聘)と、
  // 年代が上がるタイミング(U-12=12歳/ジュニアユース=15歳/ユース=18歳を超える節目)での
  // 昇格候補(誰を昇格させ、誰をリリースするか)は、オーナーがシーズン終了レビュー画面で
  // 選手ごとに決める(既定は「昇格させる」)。2軍以下(reserve)の選手は年齢上限が無いため
  // この強制判定の対象にはならず、基本的にそのまま2軍以下に残り続ける(トップチームへの
  // 昇格は「ユース組織」タブから好きなタイミングで個別に行える)。斡旋できる提携クラブが
  // あれば引退選手は既定でコーチ斡旋。
  const hasAffiliates = state.club.affiliates.length > 0;
  const retirees = topGrowth.retirees.map(r => ({
    ...r,
    decision: hasAffiliates ? 'broker' : 'none',
    coachTeam: null,
    coachRole: null,
  }));
  // 選手の殿堂(企画書12.8): 現役を全うして引退する選手のうち、今のティアの水準に照らして
  // 一流だった選手を殿堂入りさせる。
  topGrowth.retirees.forEach(r => inductHallOfFame(r, '現役引退'));
  const promoCandidates = academyGrowth.promoCandidates;

  state.seasonEndReview = {
    season: state.season,
    leagueSummary: { position: myPosition, totalTeams, prize, promoted, relegated, tierName },
    growth: {
      topCount: topGrowth.grownCount, topTotal: topGrowth.totalGrowth, topList: topGrowth.grownList,
      academyCount: academyGrowth.grownCount, academyTotal: academyGrowth.totalGrowth, academyList: academyGrowth.grownList,
    },
    retirees,
    promoCandidates,
    notes: {
      poachedTopNames: topGrowth.poachedTopNames,
      academyReleasedCount: academyGrowth.releasedCount,
      academyPoachedCount: academyGrowth.poachedCount,
      reservePoachedCount: reserveGraduation.poachedCount,
    },
  };

  state.phase = 'offseason';
}

// ---------- シーズン終了レビュー(成長・引退・ステップアップの確認/操作) ----------
// endSeason()が組み立てたstate.seasonEndReviewを画面(モーダル)で確認し、
// 「引退選手の身の振り方」「昇格候補の昇格/リリース」をオーナーが選手ごとに決める。
// 確定(applySeasonEndDecisions)まではstate.club側のプレイヤーデータは変更されない
// (academy.prospects/club.playersの実際の異動は確定時にまとめて行う)。

const ACADEMY_CATEGORY_LABEL = { u12: 'U-12', juniorYouth: 'ジュニアユース', youth: 'ユース', reserve: '2軍', top: 'トップチーム' };

// 引退選手を提携クラブへコーチ斡旋した場合の一時金(brokerRetiredPlayersAsCoachesと同じ計算式を選手単位に分解したもの)。
function srBrokerIncome(overall) {
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  const affCount = state.club.affiliates.length;
  return Math.round(overall * 3 * tierMult * (1 + affCount * 0.15));
}

// 引退選手を自クラブのコーチに招聘した場合の能力値。現役時の総合力を基準に、
// 「名選手=名コーチとは限らない」という調整でやや控えめに換算する。
function srCoachAbilityFromPlayer(overall) {
  return clamp(Math.round(overall * 0.75), 10, 95);
}

// 引退選手を自クラブコーチに招聘する際、同じ枠(チーム×役職)に複数人を
// 割り当てていないかをチェックする(超過時は確定ボタンを押せなくする)。
function srValidateReview() {
  const review = state.seasonEndReview;
  if (!review) return { ok: true, errors: [] };
  const errors = [];
  const seen = new Set();
  review.retirees.filter(r => r.decision === 'coach').forEach(r => {
    if (!r.coachTeam || !r.coachRole) {
      errors.push(`${r.name}: 招聘先のチーム・役職を選択してください。`);
      return;
    }
    const key = r.coachTeam + ':' + r.coachRole;
    if (seen.has(key)) {
      errors.push(`同じコーチ枠(${COACH_TEAM_META[r.coachTeam].label}${COACH_ROLE_META[r.coachRole].label})に複数の選手を割り当てています。`);
    }
    seen.add(key);
  });
  return { ok: errors.length === 0, errors };
}

function setRetireeDecision(id, decision) {
  const r = state.seasonEndReview.retirees.find(x => x.id === id);
  if (!r) return;
  r.decision = decision;
  if (decision !== 'coach') { r.coachTeam = null; r.coachRole = null; }
  save();
  renderSeasonReviewModal();
}

function setRetireeCoachSlot(id, teamKey, role) {
  const r = state.seasonEndReview.retirees.find(x => x.id === id);
  if (!r) return;
  r.coachTeam = teamKey || null;
  r.coachRole = role || null;
  save();
  renderSeasonReviewModal();
}

function setPromoDecision(id, decision) {
  const c = state.seasonEndReview.promoCandidates.find(x => x.id === id);
  if (!c) return;
  c.decision = decision;
  save();
  renderSeasonReviewModal();
}

// レビュー内容を確定し、実際に選手データ(club.players/academy.prospects/coaches)へ反映する。
function applySeasonEndDecisions() {
  const review = state.seasonEndReview;
  if (!review) return;
  const validation = srValidateReview();
  if (!validation.ok) { toast(validation.errors[0]); return; }

  const club = state.club;
  const logs = [];

  // --- 引退選手の身の振り方 ---
  const affCount = club.affiliates.length;
  let brokerIncomeTotal = 0, brokerCount = 0;
  const coachAppointments = [];
  review.retirees.forEach(r => {
    if (r.decision === 'broker' && affCount > 0) {
      const income = srBrokerIncome(r.overall);
      brokerIncomeTotal += income;
      brokerCount++;
    } else if (r.decision === 'coach' && r.coachTeam && r.coachRole) {
      const set = club.coaches[r.coachTeam];
      if (set) {
        set[r.coachRole] = { id: uid(), name: r.name, age: r.age, ability: srCoachAbilityFromPlayer(r.overall) };
        coachAppointments.push(`${r.name}(${COACH_TEAM_META[r.coachTeam].label}${COACH_ROLE_META[r.coachRole].label})`);
      }
    }
  });
  if (review.retirees.length) logs.push(`今シーズンは${review.retirees.length}名の選手が引退しました。`);
  if (brokerIncomeTotal > 0) {
    club.money += brokerIncomeTotal;
    club.developmentStats.coachBrokerCount += brokerCount;
    logs.push(`${brokerCount}名の引退選手を提携クラブへコーチとして斡旋し ${fmtMoney(brokerIncomeTotal)} を獲得しました。`);
  }
  if (coachAppointments.length) {
    logs.push(`引退選手を自クラブのコーチに招聘しました: ${coachAppointments.join('、')}。`);
  }

  // --- 昇格判定(ステップアップ) ---
  const prospects = club.academy.prospects;
  let bracketPromoted = 0, bracketReleased = 0, bracketSkipped = 0;

  // 昇格先カテゴリ(ジュニアユース/ユース/2軍)の保有人数上限・ポジション枠を超えないか
  // 確認してから反映する(総合力の高い順に優先し、枠切れの選手は元のカテゴリのまま
  // 留め置いて次シーズン再判定する。placeNewPlayer()等の2軍加入時と同じ考え方)。
  review.promoCandidates.filter(c => c.kind === 'bracket').sort((a, b) => b.overall - a.overall).forEach(c => {
    const idx = prospects.findIndex(p => p.id === c.id);
    if (idx < 0) return;
    if (c.decision === 'release') {
      prospects.splice(idx, 1);
      bracketReleased++;
      return;
    }
    const catCap = categoryCapacity(c.toCategory);
    const catPlayers = prospects.filter(p => p.category === c.toCategory);
    if (catPlayers.length < catCap && hasPositionRoom(catPlayers, c.pos, catCap)) {
      prospects[idx].category = c.toCategory;
      bracketPromoted++;
    } else {
      bracketSkipped++;
    }
  });

  if (bracketPromoted) logs.push(`${bracketPromoted}名がユース/ジュニアユース/U-12から上の年代へステップアップしました。`);
  if (bracketReleased) logs.push(`昇格候補のうち${bracketReleased}名をリリースしました。`);
  if (bracketSkipped) logs.push(`昇格先カテゴリの枠が上限のため、${bracketSkipped}名は元のカテゴリに留まりました。`);

  logs.forEach(text => addLog(text, 'good'));

  state.seasonEndReview = null;
  closeSeasonReviewModal();
  save();
  render();
}

// 1軍⇔2軍を、ポジションごとに「1軍+2軍を総合力順に並べて上位quota名を1軍に残す」形で
// 組み直す。空き枠を埋めるだけの昇格に留まらず、2軍に1軍の下位選手より能力が高い選手が
// いればその選手を昇格させ、押し出された1軍側の選手は2軍へ降格させる(=真の入れ替え)。
// 通常はシーズン終了レビューでのみ発生するこの入れ替えを、シーズン中いつでも手動実行できる
// ショートカットとして用意する。
function reorganizeTopByAbility() {
  const cap = squadCap();
  const prospects = state.club.academy.prospects;
  let promotedCount = 0, demotedCount = 0;

  POSITION_ORDER.forEach(pos => {
    const quota = positionQuota(pos, cap);
    const topAtPos = state.club.players.filter(p => p.pos === pos);
    const reserveAtPos = prospects.filter(p => p.category === 'reserve' && p.pos === pos);
    const combined = [
      ...topAtPos.map(p => ({ id: p.id, overall: p.overall, from: 'top' })),
      ...reserveAtPos.map(p => ({ id: p.id, overall: p.overall, from: 'reserve' })),
    ].sort((a, b) => b.overall - a.overall);
    const keep = combined.slice(0, quota);
    const keepIds = new Set(keep.map(x => x.id));

    // 昇格: 2軍→1軍(keepに残った2軍選手)
    reserveAtPos.forEach(p => {
      if (!keepIds.has(p.id)) return;
      const idx = prospects.findIndex(x => x.id === p.id);
      if (idx < 0) return;
      state.club.players.push({ id: p.id, name: p.name, pos: p.pos, age: p.age, overall: p.overall, potential: p.potential, condition: CONDITION_MAX, off: p.off, def: p.def, gk: p.gk, phy: p.phy, spd: p.spd });
      prospects.splice(idx, 1);
      state.club.developmentStats.graduatesToTop += 1;
      promotedCount++;
    });

    // 降格: 1軍→2軍(keepから外れた1軍選手)
    topAtPos.forEach(p => {
      if (keepIds.has(p.id)) return;
      const idx = state.club.players.findIndex(x => x.id === p.id);
      if (idx < 0) return;
      const dropped = state.club.players[idx];
      delete dropped.condition;
      dropped.category = 'reserve';
      prospects.push(dropped);
      state.club.players.splice(idx, 1);
      demotedCount++;
    });
  });

  if (!promotedCount && !demotedCount) { toast('入れ替えられる選手がいません(すでに能力順で最適な編成です)。'); return; }
  addLog(`1軍を能力順に組み直しました(2軍から昇格${promotedCount}名・2軍へ降格${demotedCount}名)。`, 'good');
  save();
  render();
}

let seasonReviewModalOpen = false;

function openSeasonReviewModal() {
  if (!state.seasonEndReview) return;
  seasonReviewModalOpen = true;
  document.getElementById('seasonReviewModal').classList.remove('hidden');
  renderSeasonReviewModal();
}

function closeSeasonReviewModal() {
  seasonReviewModalOpen = false;
  const el = document.getElementById('seasonReviewModal');
  if (el) el.classList.add('hidden');
  render();
}

// simulateOneRound()/debugFinishSeason()が終わった直後に呼ぶ: レビュー待ちがあれば
// (ユーザーの選択で「モーダルで自動表示」)そのままモーダルを開き、無ければ通常どおり描画する。
function maybeOpenSeasonReview() {
  if (state.seasonEndReview) openSeasonReviewModal();
  else render();
}

function srGrowthListHtml(list) {
  if (!list.length) return '<div class="empty-note">成長した選手はいませんでした。</div>';
  const top = [...list].sort((a, b) => (b.after - b.before) - (a.after - a.before)).slice(0, 20);
  const rows = top.map(g => `
    <div class="player-card">
      <div class="player-info">
        <span class="pname"><span class="pos-badge pos-${g.pos}">${g.pos}</span> ${g.name}</span>
        <span class="pmeta">${ACADEMY_CATEGORY_LABEL[g.category] || g.category} ｜ OVR ${g.before} → ${g.after} (<b style="color:var(--accent);">+${g.after - g.before}</b>)</span>
      </div>
    </div>
  `).join('');
  const moreNote = list.length > top.length ? `<div class="empty-note">他 ${list.length - top.length}名も成長しました(伸び幅の大きい順に${top.length}名を表示)。</div>` : '';
  return rows + moreNote;
}

function srRetireeRowHtml(r) {
  const hasAff = state.club.affiliates.length > 0;
  const brokerIncome = srBrokerIncome(r.overall);
  const teamOptions = COACH_TEAM_ORDER.filter(isCoachTeamOwned);
  return `
    <div class="player-card ser-row">
      <div class="player-info">
        <span class="pname"><span class="pos-badge pos-${r.pos}">${r.pos}</span> ${r.name}</span>
        <span class="pmeta">年齢 ${r.age} ｜ 現役時OVR ${r.overall}</span>
      </div>
      <div class="ser-choice">
        <div class="sub-tabs">
          <button class="sub-tab-btn ${r.decision === 'none' ? 'active' : ''}" onclick="Game.setRetireeDecision('${r.id}','none')">そのまま引退</button>
          <button class="sub-tab-btn ${r.decision === 'broker' ? 'active' : ''}" ${hasAff ? '' : 'disabled'} onclick="Game.setRetireeDecision('${r.id}','broker')">提携クラブへコーチ斡旋 (+${fmtMoney(brokerIncome)})</button>
          <button class="sub-tab-btn ${r.decision === 'coach' ? 'active' : ''}" onclick="Game.setRetireeDecision('${r.id}','coach')">自クラブのコーチに招聘</button>
        </div>
        ${r.decision === 'coach' ? `
          <div class="ser-coach-pick">
            <select class="squad-select" onchange="Game.setRetireeCoachSlot('${r.id}', this.value, '${r.coachRole || ''}')">
              <option value="">チームを選択...</option>
              ${teamOptions.map(t => `<option value="${t}" ${r.coachTeam === t ? 'selected' : ''}>${COACH_TEAM_META[t].label}</option>`).join('')}
            </select>
            <select class="squad-select" onchange="Game.setRetireeCoachSlot('${r.id}', '${r.coachTeam || ''}', this.value)" ${r.coachTeam ? '' : 'disabled'}>
              <option value="">役職を選択...</option>
              ${COACH_ROLE_ORDER.map(role => `<option value="${role}" ${r.coachRole === role ? 'selected' : ''}>${COACH_ROLE_META[role].label}</option>`).join('')}
            </select>
            ${r.coachTeam && r.coachRole ? (() => {
              const cur = state.club.coaches[r.coachTeam][r.coachRole];
              return `<div class="empty-note">現在の担当: ${cur.name}(年齢${cur.age}・能力${cur.ability}) と入れ替わります。</div>`;
            })() : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function srPromoRowHtml(c) {
  const label = `${ACADEMY_CATEGORY_LABEL[c.fromCategory]} → ${ACADEMY_CATEGORY_LABEL[c.toCategory]}`;
  // 昇格はこの画面ではまだ「候補」段階(applySeasonEndDecisions()で確定するまで反映されない)ため、
  // 表示の可否は昇格前(fromCategory)の所属で判定する。ユース→2軍のように上に上がる候補でも、
  // 実際に確定するまでは★のまま。
  const potentialLabel = isPotentialHidden(c.fromCategory) ? growthRoomHtml(c) : `潜在 ${c.potential}`;
  return `
    <div class="player-card ser-row">
      <div class="player-info">
        <span class="pname"><span class="pos-badge pos-${c.pos}">${c.pos}</span> ${c.name}</span>
        <span class="pmeta">年齢 ${c.age} ｜ OVR ${c.overall} ｜ ${potentialLabel} ｜ ${label}</span>
      </div>
      <div class="sub-tabs">
        <button class="sub-tab-btn ${c.decision === 'promote' ? 'active' : ''}" onclick="Game.setPromoDecision('${c.id}','promote')">昇格させる</button>
        <button class="sub-tab-btn ${c.decision === 'release' ? 'active' : ''}" onclick="Game.setPromoDecision('${c.id}','release')">リリース</button>
      </div>
    </div>
  `;
}

function renderSeasonReviewModal() {
  const el = document.getElementById('seasonReviewModal');
  const review = state.seasonEndReview;
  if (!el || !review) return;
  const ls = review.leagueSummary;
  const validation = srValidateReview();
  const bracketCandidates = review.promoCandidates.filter(c => c.kind === 'bracket');
  const notes = review.notes;
  const autoNotes = [];
  if (notes.poachedTopNames.length) autoNotes.push(`トップチームから引き抜き: ${notes.poachedTopNames.join('、')}`);
  if (notes.academyReleasedCount) autoNotes.push(`所持チーム無しでアカデミーを離脱: ${notes.academyReleasedCount}名`);
  if (notes.academyPoachedCount) autoNotes.push(`年代が上がるタイミングでの引き抜き: ${notes.academyPoachedCount}名`);
  if (notes.reservePoachedCount) autoNotes.push(`2軍以下からの引き抜き: ${notes.reservePoachedCount}名`);

  el.innerHTML = `
    <div class="match-viewer-box season-review-box">
      <div class="mv-header">
        <div class="mv-competition">シーズン${review.season} 終了</div>
        <div class="mv-teams"><span class="mv-team-me">${ls.tierName} 最終順位 ${ls.position}/${ls.totalTeams}位</span></div>
        <div class="mv-clock">獲得賞金 ${fmtMoney(ls.prize)}${ls.promoted ? ' ｜ ✨昇格' : ''}${ls.relegated ? ' ｜ ⚠降格' : ''}</div>
      </div>
      <div class="mv-feed ser-body">
        ${ls.promoted ? renderNewFrontierPanel(state.club.tier) : ''}
        <div class="panel">
          <h2>成長 (トップ${review.growth.topCount}名 / アカデミー${review.growth.academyCount}名、能力値合計 +${review.growth.topTotal + review.growth.academyTotal})</h2>
          <p class="empty-note">成長は自動計算です(内容の確認のみ)。</p>
          <h3>トップチーム</h3>
          ${srGrowthListHtml(review.growth.topList)}
          <h3>アカデミー</h3>
          ${srGrowthListHtml(review.growth.academyList)}
        </div>
        <div class="panel">
          <h2>年代ステップアップ判定 (${bracketCandidates.length}名)</h2>
          <p class="empty-note">U-12は12歳・ジュニアユースは15歳・ユースは18歳を超えると、上の年代へ「昇格させる」か「リリース」かを選手ごとに選べます(既定は昇格)。2軍以下(reserve)の選手は年齢上限が無いため、この判定の対象にはならず、基本的にそのまま2軍以下に残ります(トップチームへの昇格は「ユース組織」タブからいつでも個別に行えます)。</p>
          <h3>U-12→ジュニアユース→ユース→2軍</h3>
          ${bracketCandidates.length ? bracketCandidates.map(srPromoRowHtml).join('') : '<div class="empty-note">対象の選手はいません。</div>'}
          ${autoNotes.length ? `<h3>その他(自動処理)</h3>${autoNotes.map(t => `<div class="empty-note">${t}</div>`).join('')}` : ''}
        </div>
        <div class="panel">
          <h2>引退選手 (${review.retirees.length}名)</h2>
          <p class="empty-note">選手ごとに「そのまま引退」「提携クラブへコーチ斡旋」「自クラブのコーチに招聘」を選べます。</p>
          ${review.retirees.length ? review.retirees.map(srRetireeRowHtml).join('') : '<div class="empty-note">今シーズンの引退選手はいません。</div>'}
        </div>
      </div>
      <div class="mv-footer" style="flex-direction:column;align-items:stretch;">
        ${!validation.ok ? `<div class="ser-warn">${validation.errors.join('<br>')}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          <button class="ghost-btn" onclick="Game.closeSeasonReviewModal()">あとで操作する</button>
          <button class="primary-btn" ${validation.ok ? '' : 'disabled'} onclick="Game.applySeasonEndDecisions()">確定して次へ進む</button>
        </div>
      </div>
    </div>
  `;
}

function goToNextSeason() {
  state.season += 1;
  startSeason(state.club.tier);
  save();
  render();
}

// ---------- 移籍市場・施設 ----------

// 移籍市場は1シーズンを4等分するタイミング(開幕含めて年4パターン=シーズン中3回入れ替え)で
// 候補を総入れ替えする。totalRounds を4分割した節に到達した瞬間(開幕の節0は除く)が対象。
const MARKET_REFRESH_SEGMENTS = 4;

function isMarketRefreshRound(round, totalRounds) {
  if (round <= 0 || round >= totalRounds) return false;
  for (let i = 1; i < MARKET_REFRESH_SEGMENTS; i++) {
    if (round === Math.round((totalRounds * i) / MARKET_REFRESH_SEGMENTS)) return true;
  }
  return false;
}

// スカウトは施設への投資のみで機能する(移籍市場画面に手動更新ボタンは無い)。
// シーズン開始のたびに、その時点のスカウト網レベルに応じた候補を無償で自動リストアップする。
function generateMarket() {
  const tierIdx = state.club.tier;
  const scoutLv = state.club.facilities.scout;
  const scoutRatio = clamp(scoutLv / facilityMaxLevel('scout'), 0, 1);
  const count = Math.min(8, 3 + Math.round(scoutRatio * 5));
  const teamStr = teamStrength(state.club.players);
  state.market = Array.from({ length: count }, () => makeMarketPlayer(tierIdx, scoutRatio, teamStr));
}

// 1軍(トップチーム)に空きが無い場合、2軍を所持していてプールに空きがあれば
// そちらへ加入させる。tieredLevelPool()が総合力降順に26人ずつ2軍→3軍→4軍→5軍へ
// 切り出す仕組みになっているため、単にreserveプールへ追加するだけで
// 「能力順に2軍(以下)へ送られる」結果になる。
function canPlacePlayer(pos) {
  const cap = squadCap();
  if (state.club.players.length < cap && hasPositionRoom(state.club.players, pos, cap)) return true;
  if (!isCategoryOwned('reserve')) return false;
  const reserveCap = categoryCapacity('reserve');
  const reservePlayers = state.club.academy.prospects.filter(p => p.category === 'reserve');
  return reservePlayers.length < reserveCap && hasPositionRoom(reservePlayers, pos, reserveCap);
}

function placeNewPlayer(player) {
  const cap = squadCap();
  if (state.club.players.length < cap && hasPositionRoom(state.club.players, player.pos, cap)) {
    state.club.players.push(player);
    return 'top';
  }
  delete player.condition;
  player.category = 'reserve';
  state.club.academy.prospects.push(player);
  return 'reserve';
}

function buyPlayer(id) {
  const idx = state.market.findIndex(p => p.id === id);
  if (idx < 0) return;
  const candidate = state.market[idx];
  if (state.club.money < candidate.price) { toast('資金が不足しています'); return; }
  if (!canPlacePlayer(candidate.pos)) {
    toast(isCategoryOwned('reserve')
      ? '1軍・2軍以下ともに空き枠がありません'
      : `スカッドが上限です(${squadCap()}名)。2軍を所持すると、あふれた選手は自動的に2軍へ加入します。`);
    return;
  }
  const price = candidate.price;
  state.club.money -= price;
  delete candidate.price;
  state.market.splice(idx, 1);
  const dest = placeNewPlayer(candidate);
  addLog(dest === 'top'
    ? `${candidate.name} を獲得しました。(-${fmtMoney(price)})`
    : `${candidate.name} を獲得しました。トップチームが上限のため2軍に加入しました。(-${fmtMoney(price)})`,
    'good');
  save();
  render();
}

// 放出額は「現在能力(overall)」を主体に評価し、潜在能力(potential)の重みは小さくする
// (市場での購入価格は overall*8 + potential*10 が基準 → 同能力の選手を買うより
// はっきり安くなるよう overall*12 + potential*1 に抑える)。
// この設計により、獲得時にまだ overall が potential よりだいぶ低かった若手選手を
// しっかり育てて overall を potential 近くまで伸ばしてから放出すると、獲得時に支払った
// 金額を上回る黒字になりうる。逆に伸びしろを使い切っていない選手をすぐ転売しても
// 儲からない(=「しっかり育てて売る」が報われる設計)。
function sellPlayerValue(p) {
  const tierMult = TIER_PRICE_MULT[state.club.tier];
  return Math.round((p.overall * 12 + p.potential * 1) * tierMult);
}

function sellPlayer(id) {
  if (state.club.players.length <= 14) { toast('これ以上選手を放出できません(最低14名)'); return; }
  const idx = state.club.players.findIndex(p => p.id === id);
  if (idx < 0) return;
  const p = state.club.players[idx];
  const value = sellPlayerValue(p);
  state.club.money += value;
  inductHallOfFame(p, '移籍で旅立ち');
  state.club.players.splice(idx, 1);
  state.club.developmentStats.transfersOutCount += 1;
  addLog(`${p.name} を放出しました。(+${fmtMoney(value)})`, 'gold');
  save();
  render();
}

// アカデミー在籍選手(U-12/ジュニアユース/ユース/2軍)の移籍金。まだ実績がない分、
// 現在能力(overall)より潜在能力(potential)への評価比重を高くする。
// トップチームの放出(sellPlayer)より少し低い係数にし、若手ゆえの未成熟さを反映する。
function prospectSaleValue(p) {
  const tierMult = TIER_PRICE_MULT[state.club.tier];
  return Math.round((p.overall * 6 + p.potential * 9) * tierMult * 0.55);
}

function sellProspect(id) {
  const idx = state.club.academy.prospects.findIndex(p => p.id === id);
  if (idx < 0) return;
  const p = state.club.academy.prospects[idx];
  const value = prospectSaleValue(p);
  state.club.money += value;
  state.club.academy.prospects.splice(idx, 1);
  state.club.developmentStats.transfersOutCount += 1;
  addLog(`${p.name} を移籍させました。(+${fmtMoney(value)})`, 'gold');
  save();
  render();
}

// U-12→ジュニアユース→ユース→2軍という年代ステップアップは、本来は年齢がブラケットを
// 超えたシーズン末(applySeasonEndDecisions)にまとめて判定されるが、選手ごとにオーナーが
// 好きなタイミングで前倒しできるよう、スカッド画面・アカデミー画面の両方に個別の昇格
// ボタンを設ける。昇格先の在籍上限・ポジション枠は季末の一括昇格と同じ基準で確認する。
const NEXT_ACADEMY_CATEGORY = { u12: 'juniorYouth', juniorYouth: 'youth', youth: 'reserve' };
const ACADEMY_STEP_LABEL = { u12: 'U-12', juniorYouth: 'ジュニアユース', youth: 'ユース', reserve: '2軍' };

function canPromoteProspectNow(p) {
  const toCategory = NEXT_ACADEMY_CATEGORY[p.category];
  if (!toCategory) return { ok: false };
  if (!isCategoryOwned(toCategory)) return { ok: false, toCategory };
  const cap = categoryCapacity(toCategory);
  const catPlayers = state.club.academy.prospects.filter(x => x.category === toCategory);
  const room = catPlayers.length < cap && hasPositionRoom(catPlayers, p.pos, cap);
  return { ok: room, toCategory };
}

function promoteProspectNow(id) {
  const prospects = state.club.academy.prospects;
  const idx = prospects.findIndex(p => p.id === id);
  if (idx < 0) return;
  const p = prospects[idx];
  const { ok, toCategory } = canPromoteProspectNow(p);
  if (!toCategory) return;
  if (!isCategoryOwned(toCategory)) { toast(`${ACADEMY_STEP_LABEL[toCategory]}のチームをまだ所持していません`); return; }
  if (!ok) { toast('昇格先の在籍枠(ポジション枠)が空いていないため昇格できません'); return; }
  p.category = toCategory;
  addLog(`${p.name} を${ACADEMY_STEP_LABEL[toCategory]}へ昇格させました。`, 'good');
  save();
  render();
}

function prospectPromoteButtonHtml(p) {
  const toCategory = NEXT_ACADEMY_CATEGORY[p.category];
  if (!toCategory) return '';
  const { ok } = canPromoteProspectNow(p);
  return `<button class="secondary-btn" ${ok ? '' : 'disabled'} onclick="Game.promoteProspectNow('${p.id}')">${ACADEMY_STEP_LABEL[toCategory]}へ昇格させる</button>`;
}

function upgradeCost(key) {
  const lv = state.club.facilities[key];
  const tierMult = Math.sqrt(TIERS[state.club.tier].econ);
  // スカウト網は累積レベルではなく「現在のリーグ級の帯(5段階)の中の何段目か」でコストを
  // 計算する。こうしないとティアが進むほど上限が伸び続け、コストが際限なく跳ね上がるため。
  // 帯の起点は「現在のティア」で固定する(lvそのものをmodするとクラブランク加算分で
  // 同一ティア内でもLv5を超えた際にコストが不自然に下がってしまうため、ティア昇格時のみ
  // リセットされるようにする)。
  const costLv = key === 'scout' ? (lv - state.club.tier * SCOUT_LEVELS_PER_TIER + 1) : (lv + 1);
  // 企画書12.3(柱2): 最初の一段(Lv1→2)だけ指数を緩め(1.4)、初期投資のハードルを下げる。
  // 上位レベル(costLv>=3)は従来どおり1.6のまま。
  const exp = costLv <= 2 ? 1.4 : 1.6;
  return Math.round(FACILITY_META[key].base * Math.pow(costLv, exp) * tierMult);
}

function upgradeFacility(key) {
  const meta = FACILITY_META[key];
  if (meta.requires && !isCategoryOwned(meta.requires)) { toast('対象のチームを先に所持してください'); return; }
  const lv = state.club.facilities[key];
  if (lv >= facilityMaxLevel(key)) { toast('既に最大レベルです'); return; }
  const cost = upgradeCost(key);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  state.club.facilities[key] += 1;
  addLog(`${meta.label} が Lv.${state.club.facilities[key]} になりました。`, 'good');
  save();
  render();
}

function upgradeGround(category, sub) {
  if (category !== 'top' && !isCategoryOwned(category)) { toast('該当年代のチームを先に所持してください'); return; }
  const bundle = state.club.facilities.grounds[category];
  const lv = bundle[sub];
  if (lv >= groundFacilityMaxLevel()) { toast('既に最大レベルです'); return; }
  const cost = groundsCost(category, sub);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  bundle[sub] += 1;
  addLog(`${GROUND_CATEGORIES[category].label}の${GROUND_FACILITY_META[sub].label}が Lv.${bundle[sub]} になりました。`, 'good');
  save();
  render();
}

function upgradeStadium(category, sub) {
  if (category === 'reserve' && !isCategoryOwned('reserve')) { toast('先に2軍を所持してください'); return; }
  if (category === 'reserveLower' && !isCategoryOwned('reserveLower')) { toast('先に3軍以下を所持してください'); return; }
  const bundle = state.club.facilities.stadiums[category];
  const lv = bundle[sub];
  if (lv >= stadiumFacilityMaxLevel()) { toast('既に最大レベルです'); return; }
  const cost = stadiumCost(category, sub);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  bundle[sub] += 1;
  addLog(`${STADIUM_CATEGORY_LABEL[category]}の${STADIUM_FACILITY_META[sub].label}が Lv.${bundle[sub]} になりました。`, 'good');
  save();
  render();
}

function upgradeShopStadium(category) {
  if (category !== 'top' && !isCategoryOwned(category)) { toast('対象のチームを先に所持してください'); return; }
  const bundle = state.club.facilities.shopStadium;
  const lv = bundle[category];
  if (lv >= shopLocationMaxLevel()) { toast('既に最大レベルです'); return; }
  const cost = shopStadiumCost(category);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  bundle[category] += 1;
  addLog(`${STADIUM_CATEGORY_LABEL[category]}の常設ショップが Lv.${bundle[category]} になりました。`, 'good');
  save();
  render();
}

function upgradeShopGround(category) {
  if (category !== 'top' && !isCategoryOwned(category)) { toast('対象のチームを先に所持してください'); return; }
  const bundle = state.club.facilities.shopGround;
  const lv = bundle[category];
  if (lv >= shopLocationMaxLevel()) { toast('既に最大レベルです'); return; }
  const cost = shopGroundCost(category);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  bundle[category] += 1;
  addLog(`${GROUND_CATEGORIES[category].label}練習場の常設ショップが Lv.${bundle[category]} になりました。`, 'good');
  save();
  render();
}

function buyYouthTeam(key) {
  const meta = YOUTH_TEAM_META[key];
  if (state.club.youthTeams[key]) { toast('既に所持しています'); return; }
  if (meta.prereq && !state.club.youthTeams[meta.prereq]) {
    toast(`先に${YOUTH_TEAM_META[meta.prereq].label}が必要です`);
    return;
  }
  const cost = youthTeamCost(key);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  state.club.youthTeams[key] = true;
  const spCat = categoryOfTeamKey(key);
  initGroundsForCategory(spCat);
  // ユース/ジュニアユース/U-12(ユース以下)は、新設(またはユース2軍/ジュニアユース2軍解放で
  // 在籍上限が増えた分)のタイミングで、上限まで無償の選手(スカウトLv0相当のやや弱い若手)が
  // 加入する。u12の2〜5チーム目のように上限自体が変わらない場合は追加しない(同じ育成プールを
  // 共有するため)。
  let signedCount = 0;
  if (['youth', 'juniorYouth', 'u12'].includes(spCat)) {
    const cap = categoryCapacity(spCat);
    const current = state.club.academy.prospects.filter(p => p.category === spCat).length;
    signedCount = Math.max(0, cap - current);
    for (let i = 0; i < signedCount; i++) {
      state.club.academy.prospects.push(makeAcademyCandidate(spCat));
    }
  }
  // 2〜5軍はトップと表を共有しうるため、参戦可否・開始ティアは次シーズン開始時に
  // updateAdultLeagueParticipation()でまとめて判定する(ここでは何もしない)。
  // ユース/ユース2軍/ジュニアユース/ジュニアユース2軍は上記で選手を補充済みのため、
  // 通常は新設直後から11人組めて参戦できる(組めない場合もupdateReserveLeagueParticipation()が毎節確認する)。
  if (RESERVE_LEVEL_KEYS.includes(key)) {
    // no-op: 次シーズン開始時に判定
  } else if (!TIER_GATED_KEYS.includes(key) || tieredTeamCanField(key)) {
    startAcademyLeagueSeason(key, 0);
  }
  ensureCoachSet(key);
  // 新設した年代カテゴリの専用スポンサー枠が初めて解放された場合、候補をすぐ用意する
  // (次シーズン開始を待たずに「スポンサー」タブで契約できるようにするため)。
  if (['youth', 'juniorYouth', 'u12'].includes(spCat) && !state.sponsorCandidates[spCat].length && !state.club.sponsors[spCat]) {
    generateSponsorCandidates(spCat);
  }
  // ユース/ジュニアユース/U-12を新設した場合、スカウト候補も同様にすぐ用意する
  // (次シーズン開始を待たずに獲得できるようにするため)。
  if (['youth', 'juniorYouth', 'u12'].includes(spCat) && !state.academyCandidates[spCat].length) {
    generateAcademyCandidates(spCat);
  }
  addLog(`${meta.label} を新設しました。${signedCount ? `選手${signedCount}名が加入しました。` : ''}`, 'good');
  save();
  render();
}

function affiliateClub(id) {
  if (state.club.affiliates.includes(id)) { toast('既に提携しています'); return; }
  if (state.club.affiliates.length >= affiliateMax()) { toast(`提携クラブは最大${affiliateMax()}つまでです`); return; }
  const candidate = state.affiliateCandidates.find(c => c.id === id);
  if (!candidate) return;
  const myStrength = teamStrength(state.club.players);
  if (myStrength < candidate.strength + affiliateStrengthMargin()) { toast('自クラブの戦力が不足しています'); return; }
  const cost = affiliateJoinCost(candidate);
  if (state.club.money < cost) { toast('資金が不足しています'); return; }
  state.club.money -= cost;
  state.club.affiliates.push(id);
  state.affiliateRosters[id] = Array.from({ length: 3 + candidate.facilityLevel }, () => makeAffiliatePlayer(candidate));
  addLog(`${candidate.name} と提携クラブ契約を結びました。(-${fmtMoney(cost)})`, 'good');
  save();
  render();
}

function releaseAffiliate(id) {
  const idx = state.club.affiliates.indexOf(id);
  if (idx < 0) return;
  const candidate = state.affiliateCandidates.find(c => c.id === id);
  state.club.affiliates.splice(idx, 1);
  delete state.affiliateRosters[id];
  addLog(`${candidate ? candidate.name : ''}との提携を解消しました。`);
  save();
  render();
}

function buyAffiliatePlayer(affId, playerId) {
  const roster = state.affiliateRosters[affId];
  if (!roster) return;
  const idx = roster.findIndex(p => p.id === playerId);
  if (idx < 0) return;
  const player = roster[idx];
  if (state.club.money < player.price) { toast('資金が不足しています'); return; }
  if (!canPlacePlayer(player.pos)) {
    toast(isCategoryOwned('reserve')
      ? '1軍・2軍以下ともに空き枠がありません'
      : `スカッドが上限です(${squadCap()}名)。2軍を所持すると、あふれた選手は自動的に2軍へ加入します。`);
    return;
  }
  state.club.money -= player.price;
  delete player.price;
  roster.splice(idx, 1);
  const dest = placeNewPlayer(player);
  addLog(dest === 'top'
    ? `提携クラブから ${player.name} を獲得しました。`
    : `提携クラブから ${player.name} を獲得しました。トップチームが上限のため2軍に加入しました。`,
    'good');
  save();
  render();
}

// 自クラブの選手を提携クラブへ移籍させ、移籍金を得る。提携クラブの施設レベルが高いほど高値がつくが、
// 最高レベルでもトップチーム放出(sellPlayerValue)の係数は超えない範囲に抑え、
// 同能力の選手を市場で買うよりはっきり安くなるようにする。
function affiliateSaleValue(p, candidate) {
  const tierMult = TIER_PRICE_MULT[state.club.tier];
  const facilityBonus = 0.55 + candidate.facilityLevel * 0.06;
  return Math.round((p.overall * 12 + p.potential * 1) * tierMult * facilityBonus);
}

function sellPlayerToAffiliate(affId, playerId) {
  if (state.club.players.length <= 14) { toast('これ以上選手を放出できません(最低14名)'); return; }
  const candidate = state.affiliateCandidates.find(c => c.id === affId);
  if (!candidate) return;
  const idx = state.club.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;
  const p = state.club.players[idx];
  const value = affiliateSaleValue(p, candidate);
  state.club.money += value;
  state.club.players.splice(idx, 1);
  state.club.developmentStats.transfersOutCount += 1;
  addLog(`${p.name} を ${candidate.name} へ移籍させました。(+${fmtMoney(value)})`, 'gold');
  save();
  render();
}

// ---------- 描画 ----------

function renderTopBar() {
  const tier = TIERS[state.club.tier];
  const rank = computeClubRank();
  document.getElementById('clubSummary').innerHTML = `
    <span><b>${state.club.name}</b></span>
    <span>${tier.name}</span>
    <span class="money">${fmtMoney(state.club.money)}</span>
    <span>クラブランク: ${rank.label} (${rank.score}点)</span>
    <span>シーズン ${state.season}</span>
  `;
}

function renderDashboard() {
  const tier = TIERS[state.club.tier];
  const rank = computeClubRank();
  const inSeason = state.phase === 'season';
  let phaseHtml;
  if (inSeason) {
    phaseHtml = `
      <div class="phase-banner">第 ${state.currentRound + 1} / ${state.fixtures.length} 節</div>
      <div class="action-row">
        <button class="primary-btn" onclick="Game.playRound()">試合を行う</button>
        ${state.topMatchLog.length ? `<button class="ghost-btn" onclick="Game.watchTopMatch(${state.topMatchLog.length - 1})">📺直近の試合を見返す</button>` : ''}
        <button class="ghost-btn" onclick="Game.debugFinishSeason()">🐞 シーズンを消化(デバッグ)</button>
      </div>`;
  } else {
    const sum = state.lastSeasonSummary;
    const pendingReview = !!state.seasonEndReview;
    phaseHtml = `
      <div class="phase-banner">オフシーズン（移籍・強化期間）${pendingReview ? '— 今シーズンの成長・引退・ステップアップの確認が必要です。' : '— 準備ができたら次のシーズンへ進みましょう。'}</div>
      ${sum ? `<p class="empty-note">前シーズン最終順位: ${sum.position}位 (${sum.tierName}) ／ 獲得賞金: ${fmtMoney(sum.prize)}</p>` : ''}
      <div class="action-row">
        ${pendingReview
          ? `<button class="primary-btn" onclick="Game.openSeasonReviewModal()">シーズン結果を確認する</button>`
          : `<button class="primary-btn" onclick="Game.goToNextSeason()">次のシーズンへ</button>`}
      </div>`;
  }
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>クラブ状況</h2>
      <div class="grid-cards">
        <div class="stat-card"><div class="label">資金</div><div class="value">${fmtMoney(state.club.money)}</div></div>
        <div class="stat-card"><div class="label">所属リーグ</div><div class="value">${tier.name}</div></div>
        <div class="stat-card"><div class="label">クラブランク</div><div class="value">${rank.label}</div></div>
        <div class="stat-card"><div class="label">クラブランクスコア</div><div class="value">${rank.score} / 1000</div></div>
        <div class="stat-card"><div class="label">評判値</div><div class="value">${state.club.reputation} / 1000</div></div>
        <div class="stat-card"><div class="label">チーム総合力</div><div class="value">${teamStrength(state.club.players).toFixed(1)}</div></div>
        <div class="stat-card"><div class="label">スタメン想定コンディション</div><div class="value">${(() => { const xi = pickMatchXI(state.club.players).xi; return xi.length ? Math.round(xi.reduce((s, p) => s + p.condition, 0) / xi.length) : 100; })()}/100</div></div>
        <div class="stat-card"><div class="label">所属選手数</div><div class="value">${state.club.players.length}名</div></div>
        <div class="stat-card"><div class="label">提携クラブ</div><div class="value">${state.club.affiliates.length} / ${affiliateMax()}</div></div>
        <div class="stat-card"><div class="label">観客動員(目安)</div><div class="value">${Math.round(stadiumCapacity('top') * attendanceFactor(state.club.reputation)).toLocaleString()}人</div></div>
        <div class="stat-card">
          <div class="label">クラブランク内訳</div>
          <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin-top:6px;line-height:1.6;">
            トップ成績 ${rank.breakdown.top.toFixed(0)} ｜ 下部組織 ${rank.breakdown.lowerOrg.toFixed(0)} ｜ 施設 ${rank.breakdown.facility.toFixed(0)}<br>
            財政健全度 ${rank.breakdown.financial.toFixed(0)} ｜ 育成輩出実績 ${rank.breakdown.development.toFixed(0)}
          </div>
        </div>
      </div>
      ${phaseHtml}
    </div>
    ${renderNextLeaguePanel()}
    ${renderRecordsPanel()}
    ${renderHallOfFamePanel()}
    ${renderRivalPanel()}
    <div class="panel">
      <h2>クラブ履歴</h2>
      <div class="log-list">
        ${state.log.slice(-40).reverse().map(l => `<div class="log-item ${l.type}">${l.text}</div>`).join('') || '<div class="empty-note">まだ記録がありません。</div>'}
      </div>
    </div>
  `;
}

// 順位表・戦力表・カップ戦(下部組織カップ)で共通のチーム切り替え。トップチーム(1軍)の他、
// 所持している下部組織チームをそれぞれ独立したリーグ/カップとして選べる。
const LEAGUE_VIEW_TABS = [
  { key: 'top', label: 'トップ' },
  ...YOUTH_TEAM_ORDER.map(k => ({ key: k, label: YOUTH_TEAM_META[k].label })),
];
let leagueViewTab = 'top';
function setLeagueViewTab(v) { leagueViewTab = v; render(); }
function availableLeagueViewTabs() {
  return LEAGUE_VIEW_TABS.filter(t => t.key === 'top' || state.club.youthTeams[t.key]);
}
function renderLeagueViewNav(tabs, activeKey, onClickName) {
  return `<div class="sub-tabs" style="margin-bottom:14px;">${tabs.map(t => `<button class="sub-tab-btn ${activeKey === t.key ? 'active' : ''}" onclick="Game.${onClickName}('${t.key}')">${t.label}</button>`).join('')}</div>`;
}

// テーブル配列(順位表の行、または過去シーズンのlastFinalStandings)の中から、自チームの
// id(トップ='me'、2〜5軍='me_reserve'等)を全て拾い出す。トップと2〜5軍が同じ表を共有して
// いる場合、複数のidが該当しうる。
function myIdsInTable(table) {
  return table.filter(t => ownKeyForId(t.id)).map(t => t.id);
}

// 順位表テーブル本体(トップ/下部組織リーグ共通のマークアップ)。myIdsは「自クラブ」として
// ハイライトする行のid一覧(省略時は['me']=トップのみ)。
function renderStandingsTable(table, promoteCount, relegateCount, myIds = ['me']) {
  const totalTeams = table.length;
  const rows = table.map((t, i) => {
    const pos = i + 1;
    const isMine = myIds.includes(t.id);
    const cls = [
      isMine ? 'me' : '',
      promoteCount > 0 && pos <= promoteCount ? 'promo' : '',
      relegateCount > 0 && pos > totalTeams - relegateCount ? 'relegate' : '',
    ].filter(Boolean).join(' ');
    return `<tr class="${cls}">
      <td>${pos}</td>
      <td class="name-col">${t.name}${isMine ? ' (自クラブ)' : ''}</td>
      <td>${t.played}</td><td>${t.win}</td><td>${t.draw}</td><td>${t.lose}</td>
      <td>${t.gf}</td><td>${t.ga}</td><td>${t.gd > 0 ? '+' : ''}${t.gd}</td>
      <td><b>${t.pts}</b></td>
    </tr>`;
  }).join('');
  return table.length
    ? `<div style="overflow-x:auto;"><table><thead><tr><th>順位</th><th class="name-col">クラブ名</th><th>試</th><th>勝</th><th>分</th><th>負</th><th>得</th><th>失</th><th>差</th><th>勝点</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="empty-note">データがありません。</div>';
}

function renderTable() {
  const availableTabs = availableLeagueViewTabs();
  if (!availableTabs.some(t => t.key === leagueViewTab)) leagueViewTab = 'top';
  const nav = renderLeagueViewNav(availableTabs, leagueViewTab, 'setLeagueViewTab');

  let caption, tableHtml;
  if (leagueViewTab === 'top') {
    const tier = TIERS[state.club.tier];
    let table = [];
    if (state.phase === 'season') {
      table = buildSortedTable();
      caption = `${tier.name} - 第${state.currentRound + 1}/${state.fixtures.length}節終了時点`;
      const others = state.club.adultLeagues[state.club.tier].memberKeys.filter(k => k !== 'top');
      if (others.length) caption += ` ｜ ${others.map(academyLeagueLabel).join('・')}と表を共有中`;
    } else if (state.lastFinalStandings) {
      table = state.lastFinalStandings;
      caption = `${state.lastSeasonSummary.tierName} - 最終順位表（前シーズン）`;
    } else {
      caption = '';
    }
    tableHtml = renderStandingsTable(table, tier.promote, tier.relegate, myIdsInTable(table));
  } else {
    const key = leagueViewTab;
    const info = leagueDisplayInfo(key);
    if (!info) {
      caption = `${academyLeagueLabel(key)}: 参戦待機中`;
      tableHtml = `<div class="empty-note">${academyWaitingNote(key) || 'まだデータがありません。'}</div>`;
    } else {
      const tierMeta = tierMetaForKey(key, info.tierIdx);
      const maxIdx = academyLeagueMaxTierIdx(key);
      const capNote = RESERVE_LEVEL_KEYS.includes(key) && info.tierIdx === RESERVE_MAX_TIER_IDX ? `(最高位・これ以上昇格不可)` : '';
      caption = `${academyLeagueLabel(key)}: ${tierNamesForKey(key)[info.tierIdx]} (${info.tierIdx + 1}/${maxIdx + 1}段階) ${capNote} - 第${info.currentRound}/${info.totalRounds}節終了時点`;
      if (info.mergedWith.length) caption += ` ｜ ${info.mergedWith.map(adultKeyLabel).join('・')}と表を共有中`;
      tableHtml = renderStandingsTable(info.table, tierMeta.promote, tierMeta.relegate, myIdsInTable(info.table));
    }
  }
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>順位表</h2>
      ${nav}
      <div class="tier-title">${caption}</div>
      ${tableHtml}
    </div>
  `;
}

// バーは実運用上の目安スケール(99)で見せる。ABILITY_CAPは将来の超高数値に備えた
// 理論上限であり、そのまま分母にすると当面バーがほぼ埋まらず見た目上意味を成さないため。
function renderPowerCards(rows) {
  if (!rows.length) return '<div class="empty-note">データがありません。</div>';
  return rows.map((t, i) => {
    const rank = i + 1;
    const isMine = !!ownKeyForId(t.id);
    const pct = clamp(t.strength / 99 * 100, 2, 100).toFixed(0);
    return `
      <div class="player-card${isMine ? ' power-me' : ''}">
        <div class="player-info" style="flex:1;">
          <span class="pname">${rank}. ${t.name}${isMine ? ' (自クラブ)' : ''}</span>
        </div>
        <span class="pmeta">総合力 <b>${t.strength.toFixed(1)}</b></span>
        <span class="bar-outer" style="width:120px;"><span class="bar-inner" style="width:${pct}%"></span></span>
      </div>
    `;
  }).join('');
}

// teamsオブジェクト(id -> {name,strength})から戦力表の行を組み立てる。自チームid
// (トップ='me'、2〜5軍='me_reserve'等)は保存された(=nullの)strengthではなく、
// その場で実効戦力を計算し直す。
function powerRowsForTeams(teams) {
  return Object.keys(teams).map(id => {
    const ownKey = ownKeyForId(id);
    const strength = ownKey === 'top' ? myTopMatchStrength() : ownKey ? academyLeagueTeamStrength(ownKey) : teams[id].strength;
    return { id, name: teams[id].name, strength };
  }).sort((a, b) => b.strength - a.strength);
}

// キーが現在参戦しているリーグのteams/tierIdxを返す(leagueDisplayInfoの戦力表向け軽量版)。
function adultTeamsForKey(key) {
  if (RESERVE_LEVEL_KEYS.includes(key)) {
    if (!state.club.reserveActive[key]) return null;
    const tierIdx = state.club.reserveTier[key];
    return { teams: state.club.adultLeagues[tierIdx].teams, tierIdx };
  }
  const league = state.club.academyLeagues[key];
  if (!league) return null;
  return { teams: league.teams, tierIdx: league.tier };
}

function renderPower() {
  const availableTabs = availableLeagueViewTabs();
  if (!availableTabs.some(t => t.key === leagueViewTab)) leagueViewTab = 'top';
  const nav = renderLeagueViewNav(availableTabs, leagueViewTab, 'setLeagueViewTab');

  let caption, cardsHtml;
  if (leagueViewTab === 'top') {
    const tier = TIERS[state.club.tier];
    caption = `${tier.name} - このティアの目安総合力: ${tier.baseline}`;
    cardsHtml = renderPowerCards(powerRowsForTeams(state.teams));
  } else {
    const key = leagueViewTab;
    const info = adultTeamsForKey(key);
    if (!info) {
      caption = `${academyLeagueLabel(key)}: 参戦待機中`;
      cardsHtml = `<div class="empty-note">${academyWaitingNote(key) || 'まだデータがありません。'}</div>`;
    } else {
      const baseline = academyBaselineForTier(ACADEMY_LEAGUE_CATEGORY[key], info.tierIdx);
      caption = `${academyLeagueLabel(key)}: ${tierNamesForKey(key)[info.tierIdx]} - このティアの目安総合力: ${baseline}`;
      cardsHtml = renderPowerCards(powerRowsForTeams(info.teams));
    }
  }

  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>戦力表</h2>
      ${nav}
      <div class="tier-title">${caption}</div>
      <p class="empty-note">各クラブの総合力(チーム力の目安)の一覧です。自クラブは保有選手の上位11名の平均、対戦クラブはリーグ内での実力値です。数値が高いほど試合で有利になります。</p>
      ${cardsHtml}
    </div>
  `;
}

function attrStatsHtml(p) {
  return `
    <span class="attr-stats">
      <span class="attr-chip" title="オフェンス">攻${p.off}</span>
      <span class="attr-chip" title="ディフェンス">守${p.def}</span>
      <span class="attr-chip" title="ゴールキーパー">GK${p.gk}</span>
      <span class="attr-chip" title="フィジカル">体${p.phy}</span>
      <span class="attr-chip" title="スピード">速${p.spd}</span>
    </span>
  `;
}

let squadSortBy = 'ovr';
let squadFilterBy = 'all';
let squadTeamTab = 'top';
function setSquadSort(v) { squadSortBy = v; render(); }
function setSquadFilter(v) { squadFilterBy = v; render(); }
// チームを切り替えたら、そのチームには存在しない絞り込み(スタメン/ベンチ入り等は
// トップチーム限定)が残って空リストになるのを防ぐため、絞り込みを毎回リセットする。
function setSquadTeam(v) { squadTeamTab = v; squadFilterBy = 'all'; render(); }

const SQUAD_SORTS = [
  { key: 'ovr', label: 'OVR順' },
  { key: 'potential', label: '潜在値順' },
  { key: 'age', label: '年齢順' },
];
const SQUAD_POS_FILTERS = ['GK', 'DF', 'MF', 'FW'];
// トップチーム(state.club.players)以外は、アカデミー在籍選手(state.club.academy.prospects)を
// category別に切り出して表示する。2軍/3軍/4軍/5軍は同じreserveプールを能力順に切り出した
// タブごとの表示(tieredLevelPool)。
const SQUAD_TEAM_TABS = [
  { key: 'top', label: '1軍' },
  { key: 'reserve', label: '2軍' },
  { key: 'reserve3', label: '3軍' },
  { key: 'reserve4', label: '4軍' },
  { key: 'reserve5', label: '5軍' },
  { key: 'youth', label: 'ユース' },
  { key: 'juniorYouth', label: 'ジュニアユース' },
  { key: 'u12', label: 'U-12' },
];

function renderSquad() {
  const availableTabs = SQUAD_TEAM_TABS.filter(t => t.key === 'top' || isCategoryOwned(t.key));
  if (!availableTabs.some(t => t.key === squadTeamTab)) squadTeamTab = 'top';
  const isTop = squadTeamTab === 'top';
  const isReserveTier = RESERVE_LEVEL_KEYS.includes(squadTeamTab);
  const allPlayers = isTop
    ? state.club.players
    : isReserveTier
      ? tieredLevelPool(squadTeamTab)
      : state.club.academy.prospects.filter(p => p.category === squadTeamTab);
  const cap = isTop ? squadCap() : isReserveTier ? reserveLevelCapacity(squadTeamTab) : categoryCapacity(squadTeamTab);
  const starterIds = isTop ? new Set(pickMatchXI(allPlayers).xi.map(p => p.id)) : new Set();
  const bench18Ids = isTop ? new Set(pickMatchdaySquad18(allPlayers).map(p => p.id)) : new Set();
  const ages = [...new Set(allPlayers.map(p => p.age))].sort((a, b) => a - b);

  let players = allPlayers;
  if (squadFilterBy === 'starter') players = players.filter(p => starterIds.has(p.id));
  else if (squadFilterBy === 'bench18') players = players.filter(p => bench18Ids.has(p.id));
  else if (SQUAD_POS_FILTERS.includes(squadFilterBy)) players = players.filter(p => p.pos === squadFilterBy);
  else if (squadFilterBy.startsWith('age:')) {
    const age = Number(squadFilterBy.slice(4));
    players = players.filter(p => p.age === age);
  }

  const order = { GK: 0, DF: 1, MF: 2, FW: 3 };
  const sortFns = {
    ovr: (a, b) => b.overall - a.overall || order[a.pos] - order[b.pos],
    potential: (a, b) => b.potential - a.potential || order[a.pos] - order[b.pos],
    age: (a, b) => a.age - b.age || order[a.pos] - order[b.pos],
  };
  players = [...players].sort(sortFns[squadSortBy] || sortFns.ovr);

  const canSell = isTop ? state.club.players.length > 14 : true;
  const cards = players.map(p => `
    <div class="player-card">
      <div class="player-info">
        <span class="pname"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}${isTop && starterIds.has(p.id) ? ' <span class="attr-chip" title="スタメン想定">先発</span>' : isTop && bench18Ids.has(p.id) ? ' <span class="attr-chip" title="ベンチ入り想定">控</span>' : ''}</span>
        <span class="pmeta">年齢 ${p.age} ｜ OVR ${p.overall} ｜ ${potentialOrGrowthHtml(p)} <span class="bar-outer"><span class="bar-inner" style="width:${clamp(p.overall / 99 * 100, 0, 100).toFixed(0)}%"></span></span></span>
        ${isTop ? `<span class="pmeta">コンディション ${Math.round(p.condition)}/100 <span class="bar-outer"><span class="bar-inner" style="width:${clamp(p.condition, 0, 100).toFixed(0)}%"></span></span></span>` : ''}
        ${attrStatsHtml(p)}
      </div>
      ${isTop
        ? `<button class="danger-btn" ${canSell ? '' : 'disabled'} onclick="Game.sellPlayer('${p.id}')">放出 (+${fmtMoney(sellPlayerValue(p))})</button>`
        : `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">${prospectPromoteButtonHtml(p)}<button class="danger-btn" onclick="Game.sellProspect('${p.id}')">移籍させる (+${fmtMoney(prospectSaleValue(p))})</button></div>`}
    </div>
  `).join('');
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>スカッド (${players.length}/${allPlayers.length}名)</h2>
      <div class="sub-tabs" style="margin-bottom:10px;">
        ${availableTabs.map(t => `<button class="sub-tab-btn ${squadTeamTab === t.key ? 'active' : ''}" onclick="Game.setSquadTeam('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <p class="empty-note">チーム総合力: ${teamStrength(allPlayers).toFixed(1)} ｜ 保持人数: ${isTop ? `14〜${cap}` : `0〜${cap}`}名</p>
      <p class="empty-note">ポジション枠: ${POSITION_ORDER.map(pos => `${pos} ${positionCounts(allPlayers)[pos]}/${positionQuota(pos, cap)}`).join(' ｜ ')}</p>
      <div class="squad-controls">
        <div class="squad-control-group">
          <span class="squad-control-label">並び替え</span>
          <div class="sub-tabs">
            ${SQUAD_SORTS.map(s => `<button class="sub-tab-btn ${squadSortBy === s.key ? 'active' : ''}" onclick="Game.setSquadSort('${s.key}')">${s.label}</button>`).join('')}
          </div>
        </div>
        <div class="squad-control-group">
          <span class="squad-control-label">絞り込み</span>
          <div class="sub-tabs">
            <button class="sub-tab-btn ${squadFilterBy === 'all' ? 'active' : ''}" onclick="Game.setSquadFilter('all')">全員</button>
            ${isTop ? `
            <button class="sub-tab-btn ${squadFilterBy === 'starter' ? 'active' : ''}" onclick="Game.setSquadFilter('starter')">スタメン</button>
            <button class="sub-tab-btn ${squadFilterBy === 'bench18' ? 'active' : ''}" onclick="Game.setSquadFilter('bench18')">ベンチ入り(18人)</button>
            ` : ''}
            ${SQUAD_POS_FILTERS.map(pos => `<button class="sub-tab-btn ${squadFilterBy === pos ? 'active' : ''}" onclick="Game.setSquadFilter('${pos}')">${pos}</button>`).join('')}
          </div>
          <select class="squad-select" onchange="Game.setSquadFilter(this.value)">
            <option value="">年齢で絞り込み...</option>
            ${ages.map(a => `<option value="age:${a}" ${squadFilterBy === 'age:' + a ? 'selected' : ''}>${a}歳</option>`).join('')}
          </select>
        </div>
      </div>
      ${cards || '<div class="empty-note">条件に一致する選手がいません。</div>'}
    </div>
  `;
}

function renderMarket() {
  const cards = state.market.map(p => `
    <div class="player-card">
      <div class="player-info">
        <span class="pname"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}</span>
        <span class="pmeta">年齢 ${p.age} ｜ OVR ${p.overall} ｜ 潜在 ${p.potential} ｜ 価格 ${fmtMoney(p.price)}</span>
        ${attrStatsHtml(p)}
      </div>
      <button class="secondary-btn" ${state.club.money < p.price || !canPlacePlayer(p.pos) ? 'disabled' : ''} onclick="Game.buyPlayer('${p.id}')">契約</button>
    </div>
  `).join('');

  // 下部組織(U-12/ジュニアユース/ユース)のスカウト候補も、トップチームの移籍市場と
  // 同じ画面(このタブ)にまとめて表示する。所持しているカテゴリのみ表示対象。
  const academyPanels = ['u12', 'juniorYouth', 'youth'].filter(isCategoryOwned).map(cat => {
    const scoutFacilityKey = ACADEMY_SCOUT_FACILITY_KEY[cat];
    const list = state.club.academy.prospects.filter(p => p.category === cat);
    const cap = categoryCapacity(cat);
    const scoutFull = list.length >= cap;
    const candidates = state.academyCandidates[cat] || [];
    const autopilot = !!(state.club.academyAutopilot && state.club.academyAutopilot[cat]);
    const candidateCards = candidates.map(p => `
      <div class="player-card">
        <div class="player-info">
          <span class="pname"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}</span>
          <span class="pmeta">年齢 ${p.age} ｜ OVR ${p.overall} ｜ ${potentialOrGrowthHtml(p)}</span>
        </div>
        <button class="secondary-btn" ${scoutFull || autopilot ? 'disabled' : ''} onclick="Game.signAcademyCandidate('${cat}','${p.id}')">獲得する</button>
      </div>
    `).join('');
    return `
      <div class="panel">
        <h2 style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <span>${ACADEMY_CATEGORY_LABEL[cat]}スカウト候補 (在籍 ${list.length}/${cap}名)</span>
          <label style="font-size:0.75rem;font-weight:normal;color:var(--text-dim);display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" ${autopilot ? 'checked' : ''} onchange="Game.toggleAcademyAutopilot('${cat}')"> 委任(自動スカウト)
          </label>
        </h2>
        <p class="empty-note">${ACADEMY_CATEGORY_LABEL[cat]}スカウト Lv.${state.club.facilities[scoutFacilityKey]}/${facilityMaxLevel(scoutFacilityKey)} — 候補の人数と質は「施設」タブでスカウトを強化すると上がります。候補はシーズン中に何度か入れ替わります。無償で獲得できます。${autopilot ? ' <b>「委任」がONのため、候補が出るたび能力順に自動獲得されます。</b>' : ''}</p>
        ${candidateCards || '<div class="empty-note">現在の候補はいません。</div>'}
        ${scoutFull ? '<p class="empty-note">在籍上限のため、今は獲得できません。</p>' : ''}
      </div>
    `;
  }).join('');

  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>移籍市場</h2>
      <p class="empty-note">ポジション枠: ${POSITION_ORDER.map(pos => `${pos} ${positionCounts(state.club.players)[pos]}/${positionQuota(pos, squadCap())}`).join(' ｜ ')}</p>
      <p class="empty-note">スカウト網 Lv.${state.club.facilities.scout}/${facilityMaxLevel('scout')} — 候補の人数と質は「施設」タブでスカウト網を強化すると上がります。候補はシーズンごとに自動で更新されます。</p>
      <h3>獲得候補</h3>
      ${cards || '<div class="empty-note">今シーズンの候補がいません。スカウト網を強化すると次シーズンから改善します。</div>'}
    </div>
    ${academyPanels}
  `;
}

let facilitiesSubTab = 'general';
function setFacilitiesSubTab(tab) { facilitiesSubTab = tab; render(); }

let groundsCategoryTab = 'top';
function setGroundsCategory(cat) { groundsCategoryTab = cat; render(); }

let stadiumCategoryTab = 'top';
function setStadiumCategory(cat) { stadiumCategoryTab = cat; render(); }
const STADIUM_CATEGORY_ORDER = ['top', 'reserve', 'reserveLower', 'youthBelow'];
const STADIUM_CATEGORY_NAV_LABEL = { top: 'メインスタジアム', reserve: '2軍スタジアム', reserveLower: '3軍・4軍・5軍スタジアム', youthBelow: 'ユース以下' };
function stadiumCategoryOwned(cat) {
  if (cat === 'top') return true;
  if (cat === 'reserve') return isCategoryOwned('reserve');
  if (cat === 'reserveLower') return isCategoryOwned('reserveLower');
  return isCategoryOwned('anyYouth');
}

const SHOP_FLAT_KEYS = ['shopRegional', 'shopOnline', 'shopOverseas', 'shopLicense'];

function renderGeneralFacilities() {
  const cards = Object.keys(FACILITY_META).filter(key => key !== 'youthStadium' && !SHOP_FLAT_KEYS.includes(key)).map(key => {
    const meta = FACILITY_META[key];
    const lv = state.club.facilities[key];
    const max = facilityMaxLevel(key);
    const maxed = lv >= max;
    const unlocked = isCategoryOwned(meta.requires);
    const cost = maxed || !unlocked ? 0 : upgradeCost(key);
    return `
      <div class="stat-card">
        <div class="label">${meta.label} (Lv.${lv}/${max})</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${meta.desc}</div>
        <button class="secondary-btn" ${maxed || !unlocked || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeFacility('${key}')">
          ${!unlocked ? '未所持（対象チームが必要）' : maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
        </button>
      </div>
    `;
  }).join('');
  return `<div class="grid-cards">${cards}</div>`;
}

function renderGroundsFacilities() {
  const catNav = GROUND_CATEGORY_ORDER.map(cat => {
    const owned = isCategoryOwned(cat === 'top' ? null : cat);
    return `<button class="sub-tab-btn ${groundsCategoryTab === cat ? 'active' : ''}" ${owned ? '' : 'disabled'} onclick="Game.setGroundsCategory('${cat}')">${GROUND_CATEGORIES[cat].label}${owned ? '' : ' 🔒'}</button>`;
  }).join('');
  const cat = isCategoryOwned(groundsCategoryTab === 'top' ? null : groundsCategoryTab) ? groundsCategoryTab : 'top';
  const owned = isCategoryOwned(cat === 'top' ? null : cat);
  let body;
  if (!owned) {
    body = '<div class="empty-note">この年代のチームをまだ所持していません。「ユース組織」タブでチームを新設してください。</div>';
  } else {
    const bundle = state.club.facilities.grounds[cat];
    const cards = Object.keys(GROUND_FACILITY_META).map(sub => {
      const meta = GROUND_FACILITY_META[sub];
      const lv = bundle[sub];
      const groundMax = groundFacilityMaxLevel();
      const maxed = lv >= groundMax;
      const cost = maxed ? 0 : groundsCost(cat, sub);
      return `
        <div class="stat-card">
          <div class="label">${meta.label} (Lv.${lv}/${groundMax})</div>
          <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${meta.desc}</div>
          <button class="secondary-btn" ${maxed || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeGround('${cat}','${sub}')">
            ${maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
          </button>
        </div>
      `;
    }).join('');
    body = `<div class="grid-cards">${cards}</div>`;
  }
  return `<div class="sub-tabs" style="margin-bottom:14px;">${catNav}</div>${body}`;
}

// メインスタジアム・2軍スタジアムは、メインスタンド/サブスタンド/VIPルーム/ビール/食事の
// 5項目からなる詳細なバンドルとして表示する。ユース以下は1項目に集約した簡易施設として表示する。
function renderStadiumFacilities() {
  const catNav = STADIUM_CATEGORY_ORDER.map(cat => {
    const owned = stadiumCategoryOwned(cat);
    return `<button class="sub-tab-btn ${stadiumCategoryTab === cat ? 'active' : ''}" ${owned ? '' : 'disabled'} onclick="Game.setStadiumCategory('${cat}')">${STADIUM_CATEGORY_NAV_LABEL[cat]}${owned ? '' : ' 🔒'}</button>`;
  }).join('');
  const cat = stadiumCategoryOwned(stadiumCategoryTab) ? stadiumCategoryTab : 'top';
  const owned = stadiumCategoryOwned(cat);
  let body;
  if (!owned) {
    body = '<div class="empty-note">対象のチームをまだ所持していません。「ユース組織」タブでチームを新設してください。</div>';
  } else if (cat === 'youthBelow') {
    const lv = state.club.facilities.youthStadium;
    const max = facilityMaxLevel('youthStadium');
    const maxed = lv >= max;
    const cost = maxed ? 0 : upgradeCost('youthStadium');
    body = `<div class="grid-cards">
      <div class="stat-card">
        <div class="label">${FACILITY_META.youthStadium.label} (Lv.${lv}/${max})</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${FACILITY_META.youthStadium.desc}</div>
        <button class="secondary-btn" ${maxed || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeFacility('youthStadium')">
          ${maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
        </button>
      </div>
    </div>`;
  } else {
    const capacity = stadiumCapacity(cat);
    const attendance = Math.round(capacity * attendanceFactor(state.club.reputation));
    const cards = STADIUM_FACILITY_ORDER.map(sub => {
      const meta = STADIUM_FACILITY_META[sub];
      const lv = state.club.facilities.stadiums[cat][sub];
      const stadiumMax = stadiumFacilityMaxLevel();
      const maxed = lv >= stadiumMax;
      const cost = maxed ? 0 : stadiumCost(cat, sub);
      return `
        <div class="stat-card">
          <div class="label">${meta.label} (Lv.${lv}/${stadiumMax})</div>
          <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${meta.desc}</div>
          <button class="secondary-btn" ${maxed || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeStadium('${cat}','${sub}')">
            ${maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
          </button>
        </div>
      `;
    }).join('');
    body = `<p class="empty-note">収容人数目安: ${capacity.toLocaleString()}人 ｜ 現在の想定観客動員数: ${attendance.toLocaleString()}人（評判値により変動）。${cat === 'top' ? 'この収容人数はクラブの格にも反映されます。' : ''}</p><div class="grid-cards">${cards}</div>`;
  }
  return `<div class="sub-tabs" style="margin-bottom:14px;">${catNav}</div>${body}`;
}

function renderYouthOrgFacilities() {
  const cards = YOUTH_TEAM_ORDER.map(key => {
    const meta = YOUTH_TEAM_META[key];
    const owned = state.club.youthTeams[key];
    const prereqOk = !meta.prereq || state.club.youthTeams[meta.prereq];
    const cost = youthTeamCost(key);
    const firstOfBranch = !owned && prereqOk && isFirstYouthUnitOfBranch(key);
    let label;
    if (owned) label = '所持済み';
    else if (!prereqOk) label = `${YOUTH_TEAM_META[meta.prereq].label}が必要`;
    else label = `新設 (${fmtMoney(cost)})`;
    return `
      <div class="stat-card">
        <div class="label">${meta.label}${firstOfBranch ? ' <span style="color:var(--good,#5ad18a);font-size:0.7rem;">初回割引</span>' : ''}</div>
        <button class="secondary-btn" style="margin-top:6px;" ${owned || !prereqOk || state.club.money < cost ? 'disabled' : ''} onclick="Game.buyYouthTeam('${key}')">${label}</button>
      </div>
    `;
  }).join('');
  return `<p class="empty-note">下部組織チームを新設すると、対応する年代の「練習場」タブや専用スカウトが解放されます。前提となるチームを先に所持する必要があります。各系統(2軍系／ユース／ジュニアユース／U-12)の<b>最初の1チームは大幅割引</b>で持てます。</p><div class="grid-cards">${cards}</div>`;
}

// ショップ施設タブ: 常設ショップ(スタジアム型/練習場型、所持している各カテゴリに1枚ずつカード表示)+
// 地方展開・EC・海外・ライセンスのフラット施設。いずれもホーム/アウェーを問わず毎週収入に加算される
// (5.3節参照)。所持していないカテゴリは鍵アイコン付きの無効カードとして表示するだけに留める。
function renderShopFacilities() {
  const stadiumCards = ['top', 'reserve', 'reserveLower'].map(cat => {
    const owned = cat === 'top' || isCategoryOwned(cat);
    if (!owned) {
      return `<div class="stat-card"><div class="label">${STADIUM_CATEGORY_LABEL[cat]}の常設ショップ 🔒</div><div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">対象のチームを先に所持してください</div></div>`;
    }
    const lv = state.club.facilities.shopStadium[cat];
    const max = shopLocationMaxLevel();
    const maxed = lv >= max;
    const cost = maxed ? 0 : shopStadiumCost(cat);
    return `
      <div class="stat-card">
        <div class="label">${STADIUM_CATEGORY_LABEL[cat]}の常設ショップ (Lv.${lv}/${max})</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${SHOP_LOCATION_META.desc}</div>
        <button class="secondary-btn" ${maxed || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeShopStadium('${cat}')">
          ${maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
        </button>
      </div>
    `;
  }).join('');
  const groundCards = GROUND_CATEGORY_ORDER.map(cat => {
    const owned = cat === 'top' || isCategoryOwned(cat);
    if (!owned) {
      return `<div class="stat-card"><div class="label">${GROUND_CATEGORIES[cat].label}練習場の常設ショップ 🔒</div><div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">対象年代のチームを先に所持してください</div></div>`;
    }
    const lv = state.club.facilities.shopGround[cat];
    const max = shopLocationMaxLevel();
    const maxed = lv >= max;
    const cost = maxed ? 0 : shopGroundCost(cat);
    return `
      <div class="stat-card">
        <div class="label">${GROUND_CATEGORIES[cat].label}練習場の常設ショップ (Lv.${lv}/${max})</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${SHOP_LOCATION_META.desc}</div>
        <button class="secondary-btn" ${maxed || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeShopGround('${cat}')">
          ${maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
        </button>
      </div>
    `;
  }).join('');
  const flatCards = SHOP_FLAT_KEYS.map(key => {
    const meta = FACILITY_META[key];
    const lv = state.club.facilities[key];
    const max = facilityMaxLevel(key);
    const maxed = lv >= max;
    const unlocked = isCategoryOwned(meta.requires);
    const cost = maxed || !unlocked ? 0 : upgradeCost(key);
    return `
      <div class="stat-card">
        <div class="label">${meta.label} (Lv.${lv}/${max})</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${meta.desc}</div>
        <button class="secondary-btn" ${maxed || !unlocked || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeFacility('${key}')">
          ${!unlocked ? '未解放' : maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
        </button>
      </div>
    `;
  }).join('');
  const productCards = SHOP_PRODUCT_KEYS.map(key => {
    const meta = SHOP_PRODUCT_META[key];
    const lv = state.club.facilities.shopProducts[key];
    const max = shopProductMaxLevel();
    const maxed = lv >= max;
    const cost = maxed ? 0 : shopProductCost(key);
    return `
      <div class="stat-card">
        <div class="label">${meta.label} (Lv.${lv}/${max})</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">${meta.desc}</div>
        <button class="secondary-btn" ${maxed || state.club.money < cost ? 'disabled' : ''} onclick="Game.upgradeShopProduct('${key}')">
          ${maxed ? '最大レベル' : '強化 (' + fmtMoney(cost) + ')'}
        </button>
      </div>
    `;
  }).join('');
  return `
    <p class="empty-note">ショップ施設の収入はホーム/アウェーを問わず毎週加算されます(評判に応じて変動)。</p>
    <h3>常設ショップ(スタジアム型)</h3>
    <div class="grid-cards">${stadiumCards}</div>
    <h3 style="margin-top:16px;">常設ショップ(練習場型)</h3>
    <div class="grid-cards">${groundCards}</div>
    <h3 style="margin-top:16px;">地方展開・EC・海外・ライセンス</h3>
    <div class="grid-cards">${flatCards}</div>
    <h3 style="margin-top:16px;">取り扱い商品</h3>
    <p class="empty-note">商品ごとに人気(評判)への感応度が異なります。ユニフォームは評判が高いほど大きく伸びる看板商品、雑貨・フードは評判に左右されにくい底堅い商品です。</p>
    <div class="grid-cards">${productCards}</div>
  `;
}

function renderFacilities() {
  const subNav = `
    <div class="sub-tabs">
      <button class="sub-tab-btn ${facilitiesSubTab === 'general' ? 'active' : ''}" onclick="Game.setFacilitiesSubTab('general')">全体施設</button>
      <button class="sub-tab-btn ${facilitiesSubTab === 'grounds' ? 'active' : ''}" onclick="Game.setFacilitiesSubTab('grounds')">練習場</button>
      <button class="sub-tab-btn ${facilitiesSubTab === 'stadium' ? 'active' : ''}" onclick="Game.setFacilitiesSubTab('stadium')">スタジアム</button>
      <button class="sub-tab-btn ${facilitiesSubTab === 'shop' ? 'active' : ''}" onclick="Game.setFacilitiesSubTab('shop')">ショップ</button>
      <button class="sub-tab-btn ${facilitiesSubTab === 'youthOrg' ? 'active' : ''}" onclick="Game.setFacilitiesSubTab('youthOrg')">ユース組織</button>
    </div>`;
  let body;
  if (facilitiesSubTab === 'grounds') body = renderGroundsFacilities();
  else if (facilitiesSubTab === 'stadium') body = renderStadiumFacilities();
  else if (facilitiesSubTab === 'shop') body = renderShopFacilities();
  else if (facilitiesSubTab === 'youthOrg') body = renderYouthOrgFacilities();
  else body = renderGeneralFacilities();
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>施設</h2>
      ${subNav}
      ${body}
    </div>
  `;
}

// 下部組織リーグが「所持しているが未参戦(11人組めるのを待っている)」状態かどうかの案内文。
// 参戦中/未所持(そもそもこの案内が不要)ならnullを返す。renderLeagueBoxと、順位表/戦力表/
// カップ戦タブのチーム切り替え(下記)の両方から共通で使う。
function academyWaitingNote(key) {
  if (RESERVE_LEVEL_KEYS.includes(key)) {
    // 2〜5軍はトップと表を共有するため、11人組めても参戦は次シーズン開始時から
    // (updateAdultLeagueParticipation参照)。
    if (!state.club.youthTeams[key] || state.club.reserveActive[key]) return null;
    const count = tieredLevelPool(key).length;
    const rejoinTier = state.club.reserveRejoinTier[key] || 0;
    if (count >= RESERVE_MIN_SQUAD_SIZE) {
      return `${RESERVE_MIN_SQUAD_SIZE}人組めています。次シーズン開始時から${tierNamesForKey(key)[rejoinTier]}で参戦します。`;
    }
    return `現在${count}/${RESERVE_MIN_SQUAD_SIZE}人 ｜ ${RESERVE_MIN_SQUAD_SIZE}人組めると、次シーズン開始時から${tierNamesForKey(key)[rejoinTier]}で参戦します。`;
  }
  if (state.club.academyLeagues[key]) return null;
  if (!(state.club.youthTeams[key] && TIER_GATED_KEYS.includes(key))) return null;
  const count = tieredLevelPool(key).length;
  return `現在${count}/${RESERVE_MIN_SQUAD_SIZE}人 ｜ ${RESERVE_MIN_SQUAD_SIZE}人組めると${tierNamesForKey(key)[state.club.reserveRejoinTier[key] || 0]}から参戦を開始します。`;
}

// リーグ表示(順位表・戦力表・アカデミータブの下部組織リーグ表示)向けに、キーの現在の
// 参戦状態を正規化する。2〜5軍(RESERVE_LEVEL_KEYS)はadultLeagues/reserveTier経由、
// それ以外(ユース以下)は従来どおりacademyLeagues[key]経由。未参戦ならnullを返す
// (呼び出し側はacademyWaitingNote()で案内文を出す)。
function leagueDisplayInfo(key) {
  if (RESERVE_LEVEL_KEYS.includes(key)) {
    if (!state.club.reserveActive[key]) return null;
    const tierIdx = state.club.reserveTier[key];
    const adultLeague = state.club.adultLeagues[tierIdx];
    return {
      table: buildLeagueSortedTable(adultLeague), tierIdx, id: adultIdForKey(key),
      totalRounds: adultLeague.fixtures.length, currentRound: state.currentRound,
      matchLog: state.club.reserveMatchLog[key] || [],
      mergedWith: adultLeague.memberKeys.filter(k => k !== key),
    };
  }
  const league = state.club.academyLeagues[key];
  if (!league) return null;
  return {
    table: buildLeagueSortedTable(league), tierIdx: league.tier, id: 'me',
    totalRounds: league.fixtures.length, currentRound: league.currentRound,
    matchLog: league.myMatchLog || [], mergedWith: [],
  };
}

// 下部組織リーグ1つぶんの現在の順位・成績を、コンパクトなカードとして表示する。
function renderLeagueBox(key) {
  const info = leagueDisplayInfo(key);
  if (!info) {
    const note = academyWaitingNote(key);
    if (!note) return '';
    return `
      <div class="stat-card">
        <div class="label">${academyLeagueLabel(key)}: 参戦待機中</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin-top:6px;">${note}</div>
      </div>
    `;
  }
  const { table, tierIdx, id, totalRounds, currentRound, matchLog, mergedWith } = info;
  const totalTeams = table.length;
  const myPos = table.findIndex(t => t.id === id) + 1;
  const myRow = table[myPos - 1];
  const maxIdx = academyLeagueMaxTierIdx(key);
  const capNote = RESERVE_LEVEL_KEYS.includes(key) && tierIdx === RESERVE_MAX_TIER_IDX ? `(最高位・${academyLeagueLabel(key)}はこれ以上昇格不可)` : '';
  const mergedNote = mergedWith.length
    ? `<div class="pmeta" style="color:var(--gold,#d4af37);font-size:0.7rem;margin-top:4px;">${mergedWith.map(adultKeyLabel).join('・')}と同じ表を共有中</div>`
    : '';
  const logOpen = expandedLeagueLog === key;
  const logHtml = logOpen ? `
    <div class="mini-log">
      ${matchLog.length ? [...matchLog].reverse().map(m => `
        <div class="mini-log-row ${m.result === 'win' ? 'win' : m.result === 'lose' ? 'lose' : ''}">
          第${m.round}節 ${m.isHome ? '(H)' : '(A)'} vs ${m.oppName} ${m.myGoals}-${m.oppGoals} ${m.result === 'win' ? '勝' : m.result === 'draw' ? '分' : '負'}
        </div>
      `).join('') : '<div class="empty-note">まだ試合がありません。</div>'}
    </div>
  ` : '';
  return `
    <div class="stat-card">
      <div class="label">${academyLeagueLabel(key)}: ${tierNamesForKey(key)[tierIdx]} (${tierIdx + 1}/${maxIdx + 1}段階) ${capNote}</div>
      <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin-top:6px;">
        ${myPos}位/${totalTeams} ｜ ${myRow.win}勝${myRow.draw}分${myRow.lose}敗 ｜ 勝点${myRow.pts} ｜ 第${currentRound}/${totalRounds}節
      </div>
      ${mergedNote}
      <button class="ghost-btn" style="margin-top:8px;padding:4px 8px;font-size:0.7rem;" onclick="Game.toggleLeagueLog('${key}')">${logOpen ? '試合結果を閉じる' : '試合結果を見る'}</button>
      ${logHtml}
    </div>
  `;
}

function renderAcademy() {
  const catLabel = { u12: 'U-12', juniorYouth: 'ジュニアユース', youth: 'ユース', reserve: '2軍', reserve3: '3軍', reserve4: '4軍', reserve5: '5軍' };
  // 本体の育成プールを持たない「2軍的」バリエーション(本体カテゴリのリーグ表示に併記する)。
  // 2軍/3軍/4軍/5軍は同じreserveプールを能力順に切り出したタブごとの表示のため、それぞれ
  // 独立したセクションとして扱う(併記の必要は無い)。
  const extraLeagueKeys = { u12: [], juniorYouth: ['juniorYouthReserve'], youth: ['youthReserve'], reserve: [], reserve3: [], reserve4: [], reserve5: [] };
  const sections = ['u12', 'juniorYouth', 'youth', ...RESERVE_LEVEL_KEYS].map(cat => {
    const owned = isCategoryOwned(cat);
    const isReserveTier = RESERVE_LEVEL_KEYS.includes(cat);
    const list = isReserveTier
      ? tieredLevelPool(cat)
      : state.club.academy.prospects.filter(p => p.category === cat).sort((a, b) => b.overall - a.overall);
    const cap = owned ? (isReserveTier ? reserveLevelCapacity(cat) : categoryCapacity(cat)) : 0;
    const items = list.map(p => `
      <div class="player-card">
        <div class="player-info">
          <span class="pname"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}</span>
          <span class="pmeta">年齢 ${p.age} ｜ OVR ${p.overall} ｜ ${potentialOrGrowthHtml(p)}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">${prospectPromoteButtonHtml(p)}<button class="danger-btn" onclick="Game.sellProspect('${p.id}')">移籍させる (+${fmtMoney(prospectSaleValue(p))})</button></div>
      </div>
    `).join('');

    let leagueBoxes;
    if (cat === 'u12') {
      leagueBoxes = ['u12_1', 'u12_2', 'u12_3', 'u12_4', 'u12_5'].map(renderLeagueBox).join('');
    } else {
      leagueBoxes = renderLeagueBox(cat) + extraLeagueKeys[cat].map(renderLeagueBox).join('');
    }

    return `
      <div class="panel">
        <h2>${catLabel[cat]} ${owned ? `(${list.length}/${cap}名)` : '(未所持)'}</h2>
        ${owned && cat === 'reserve' ? `<button class="secondary-btn" style="margin-bottom:10px;" onclick="Game.reorganizeTopByAbility()">各ポジションを能力順に1軍から埋め直す(2軍と入れ替え)</button>` : ''}
        ${owned ? `<p class="empty-note">ポジション枠: ${POSITION_ORDER.map(pos => `${pos} ${positionCounts(list)[pos]}/${positionQuota(pos, cap)}`).join(' ｜ ')}</p>` : ''}
        ${owned && ACADEMY_SCOUT_FACILITY_KEY[cat] ? `<p class="empty-note">新加入選手のスカウトは「移籍市場」タブから行えます。</p>` : ''}
        ${leagueBoxes ? `<div class="grid-cards" style="margin-bottom:14px;">${leagueBoxes}</div>` : ''}
        ${owned ? (items || '<div class="empty-note">現在在籍する選手はいません。</div>') : '<div class="empty-note">「施設」タブの「ユース組織」でチームを新設してください。</div>'}
      </div>
    `;
  }).join('');
  document.getElementById('content').innerHTML = sections;
}

function renderAffiliates() {
  const myStrength = teamStrength(state.club.players);
  const affiliated = state.club.affiliates.map(id => state.affiliateCandidates.find(c => c.id === id)).filter(Boolean);
  const candidates = state.affiliateCandidates.filter(c => !state.club.affiliates.includes(c.id));

  const affiliatedHtml = affiliated.map(c => {
    const roster = state.affiliateRosters[c.id] || [];
    const players = roster.map(p => `
      <div class="player-card">
        <div class="player-info">
          <span class="pname"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}</span>
          <span class="pmeta">年齢 ${p.age} ｜ OVR ${p.overall} ｜ 潜在 ${p.potential} ｜ 価格 ${fmtMoney(p.price)}</span>
        </div>
        <button class="secondary-btn" ${state.club.money < p.price || !canPlacePlayer(p.pos) ? 'disabled' : ''} onclick="Game.buyAffiliatePlayer('${c.id}','${p.id}')">獲得</button>
      </div>
    `).join('');
    return `
      <div class="panel">
        <h2>${c.name} <span style="font-size:0.75rem;color:var(--text-dim);font-weight:normal;">(戦力目安 ${c.strength} ｜ 施設Lv.${c.facilityLevel} ｜ ${c.focus === 'young' ? '育成型・若手中心' : 'バランス型'})</span></h2>
        <p class="empty-note">維持費: ${fmtMoney(affiliateMaintenanceCost(c))}/週 ｜ 在籍選手はシーズン開始時に更新されます。</p>
        ${players || '<div class="empty-note">現在獲得可能な選手はいません。次シーズン開始時に更新されます。</div>'}
        <button class="danger-btn" style="margin-top:10px;" onclick="Game.releaseAffiliate('${c.id}')">提携を解消</button>
      </div>
    `;
  }).join('');

  const canSellToAffiliate = state.club.players.length > 14;
  const sellHtml = affiliated.length ? `
    <div class="panel">
      <h2>選手を提携クラブへ移籍させる</h2>
      <p class="empty-note">自クラブの選手を提携クラブへ移籍させ、移籍金を得られます(最低保持人数14名)。提携クラブの施設レベルが高いほど高値がつきます。</p>
      ${state.club.players.map(p => `
        <div class="player-card">
          <div class="player-info">
            <span class="pname"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}</span>
            <span class="pmeta">年齢 ${p.age} ｜ OVR ${p.overall} ｜ 潜在 ${p.potential}</span>
          </div>
          <select class="squad-select" ${canSellToAffiliate ? '' : 'disabled'} onchange="if(this.value) Game.sellPlayerToAffiliate(this.value,'${p.id}')">
            <option value="">移籍先を選択...</option>
            ${affiliated.map(c => `<option value="${c.id}">${c.name} (+${fmtMoney(affiliateSaleValue(p, c))})</option>`).join('')}
          </select>
        </div>
      `).join('')}
    </div>
  ` : '';

  const candidatesHtml = candidates.map(c => {
    const requiredStrength = c.strength + affiliateStrengthMargin();
    const unlocked = myStrength >= requiredStrength;
    const full = state.club.affiliates.length >= affiliateMax();
    const cost = affiliateJoinCost(c);
    const affordable = state.club.money >= cost;
    const firstAff = state.club.affiliates.length === 0;
    let btnLabel;
    if (full) btnLabel = '提携枠が上限です';
    else if (!unlocked) btnLabel = `要求戦力 ${requiredStrength.toFixed(0)} (自クラブ ${myStrength.toFixed(1)})`;
    else btnLabel = `提携する (${fmtMoney(cost)})${firstAff ? ' ★初回割引' : ''}`;
    return `
      <div class="stat-card">
        <div class="label">${c.name}</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">戦力目安 ${c.strength} ｜ 施設Lv.${c.facilityLevel} ｜ ${c.focus === 'young' ? '育成型・若手中心' : 'バランス型'}</div>
        <button class="secondary-btn" ${!unlocked || full || !affordable ? 'disabled' : ''} onclick="Game.affiliateClub('${c.id}')">${btnLabel}</button>
      </div>
    `;
  }).join('');

  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>提携クラブ (${affiliated.length}/${affiliateMax()})</h2>
      <p class="empty-note">全${AFFILIATE_POOL_SIZE}クラブの中から最大${affiliateMax()}つまで提携できます(所属リーグ級が上がるほど上限は広がります)。自クラブの戦力が相手クラブの戦力を${affiliateStrengthMargin()}以上上回っていないと提携できません。提携クラブは施設状況に応じた戦力・年代の選手を抱えており、シーズン(年)が変わるタイミングで選手が入れ替わり、お金を払って獲得できます。逆に自クラブの選手を提携クラブへ移籍させて移籍金を得ることもできます。また選手が引退した際、提携クラブがあればコーチとして斡旋し一時金を得られます。<b>初の提携クラブは加入費が半額</b>で、提携が1つの間は維持費も割引されます。</p>
    </div>
    ${sellHtml}
    ${affiliatedHtml}
    <div class="panel">
      <h2>提携候補クラブ</h2>
      <div class="grid-cards">${candidatesHtml}</div>
    </div>
  `;
}

// ---------- スポンサー ----------

function renderSponsorSlotCard(category, slot, slotIndex) {
  if (slot) {
    const est = sponsorEstIncome(slot, category);
    const grade = SPONSOR_GRADE_LABEL[slot.tierIdx];
    return `
      <div class="stat-card">
        <div class="label">${slot.name}</div>
        <div class="pmeta" style="color:var(--gold, #d4af37);font-size:0.72rem;margin:4px 0;">${grade}</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:0 0 10px;">週間収入目安 ${fmtMoney(est)} ｜ 成長ボーナス +${slot.effect.growth} ｜ 残り契約 ${slot.seasonsLeft}シーズン</div>
        <button class="danger-btn" onclick="Game.releaseSponsor('${category}',${slotIndex})">契約を解消</button>
      </div>
    `;
  }
  return `
    <div class="stat-card">
      <div class="label">空き枠</div>
      <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">下の候補から契約してください。</div>
    </div>
  `;
}

function renderSponsorLockedCard(reqRep) {
  return `
    <div class="stat-card" style="opacity:0.6;">
      <div class="label">🔒 未解放</div>
      <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:6px 0 10px;">評判値 ${reqRep} で解放されます(現在 ${state.club.reputation})</div>
    </div>
  `;
}

// 空き枠が無くても契約候補は常に閲覧できる。空き枠がある場合はそのままボタンで契約、
// 無い場合は入れ替え対象を選ぶセレクトを出し、契約解除→契約を1操作で行えるようにする。
function sponsorHasOpenSlot(category) {
  if (category === 'general') {
    const unlocked = generalSponsorSlotsUnlocked();
    return state.club.sponsors.general.some((s, i) => !s && i < unlocked);
  }
  return !state.club.sponsors[category];
}

function renderSponsorCandidates(category) {
  const list = state.sponsorCandidates[category] || [];
  if (!list.length) return '<div class="empty-note">現在契約可能な候補はいません(シーズン開始時に更新されます)。</div>';
  const hasOpenSlot = sponsorHasOpenSlot(category);
  const filledSlots = category === 'general'
    ? state.club.sponsors.general.map((s, i) => (s ? { i, s } : null)).filter(Boolean)
    : (state.club.sponsors[category] ? [{ i: 0, s: state.club.sponsors[category] }] : []);
  const cards = list.map(c => {
    const est = sponsorEstIncome(c, category);
    const grade = SPONSOR_GRADE_LABEL[c.tierIdx];
    const action = hasOpenSlot
      ? `<button class="secondary-btn" onclick="Game.signSponsor('${category}','${c.id}')">契約する</button>`
      : `
        <select class="squad-select" onchange="if(this.value!=='') Game.signSponsor('${category}','${c.id}', this.value)">
          <option value="">入れ替えて契約する...</option>
          ${filledSlots.map(o => `<option value="${o.i}">${o.s.name}を解約(残り${o.s.seasonsLeft}季)</option>`).join('')}
        </select>
      `;
    return `
      <div class="stat-card">
        <div class="label">${c.name}</div>
        <div class="pmeta" style="color:var(--gold, #d4af37);font-size:0.72rem;margin:4px 0;">${grade}</div>
        <div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin:0 0 10px;">週間収入目安 ${fmtMoney(est)} ｜ 成長ボーナス +${c.effect.growth}</div>
        ${action}
      </div>
    `;
  }).join('');
  const note = hasOpenSlot ? '契約候補' : '契約候補(空き枠なし・入れ替え先を選ぶと契約できます)';
  return `<p class="empty-note" style="margin-top:14px;">${note}</p><div class="grid-cards">${cards}</div>`;
}

function renderSponsors() {
  const unlocked = generalSponsorSlotsUnlocked();
  const generalCount = state.club.sponsors.general.filter(Boolean).length;
  const generalSlots = state.club.sponsors.general.map((s, i) => {
    return i < unlocked ? renderSponsorSlotCard('general', s, i) : renderSponsorLockedCard(SPONSOR_SLOT_UNLOCK_REP[i]);
  }).join('');
  const specialSections = ['youth', 'juniorYouth', 'u12'].map(cat => {
    const owned = isCategoryOwned(cat);
    const slot = state.club.sponsors[cat];
    let body;
    if (!owned) {
      body = `<div class="empty-note">${sponsorCategoryLabel(cat)}のチームを1つ以上所持すると専用スポンサー枠が解放されます。</div>`;
    } else {
      body = `<div class="grid-cards">${renderSponsorSlotCard(cat, slot, 0)}</div>${renderSponsorCandidates(cat)}`;
    }
    return `
      <div class="panel">
        <h2>${sponsorCategoryLabel(cat)}専用スポンサー ${owned ? `(${slot ? 1 : 0}/1)` : '(未解放)'}</h2>
        ${body}
      </div>
    `;
  }).join('');

  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>全体スポンサー (${generalCount}/${unlocked}解放中 ・ 最大${SPONSOR_GENERAL_SLOTS})</h2>
      <p class="empty-note">最初は小さな地元スポンサー1枠のみですが、評判値(成績の積み重ね)が上がるほど枠が解放されていきます(評判 ${SPONSOR_SLOT_UNLOCK_REP.slice(1).join(' / ')} で追加解放)。リーグを昇格しティアが上がるほど、地元スポンサー→地方企業→日本の大企業→世界的大企業へと候補の顔ぶれも格上げされ、金額も大きくなります。契約は${SPONSOR_CONTRACT_SEASONS}シーズンで満了し、再契約が必要です。各スポンサーは収入に加えて選手の成長速度を上げる効果も持っています。ユース・ジュニアユース・U-12のチームをそれぞれ1つ以上所持すると、その年代に響く専用スポンサー枠が1つずつ追加されます。</p>
      <div class="grid-cards">${generalSlots}</div>
      ${renderSponsorCandidates('general')}
    </div>
    ${specialSections}
  `;
}

// ---------- コーチ人事 ----------

let selectedCoachSlot = null;

// 枠をクリックすると選択状態になり、続けて別の枠をクリックするとその2枠のコーチを
// 入れ替える(同じ枠を再クリックすると選択解除)。どのチーム・どの役職間でも自由に入れ替え可能。
function selectCoachSlot(teamKey, role) {
  if (!isCoachTeamOwned(teamKey)) return;
  if (!selectedCoachSlot) {
    selectedCoachSlot = { teamKey, role };
  } else if (selectedCoachSlot.teamKey === teamKey && selectedCoachSlot.role === role) {
    selectedCoachSlot = null;
  } else {
    const fromSet = state.club.coaches[selectedCoachSlot.teamKey];
    const toSet = state.club.coaches[teamKey];
    const a = fromSet[selectedCoachSlot.role];
    const b = toSet[role];
    fromSet[selectedCoachSlot.role] = b;
    toSet[role] = a;
    addLog(`${COACH_TEAM_META[selectedCoachSlot.teamKey].label}${COACH_ROLE_META[selectedCoachSlot.role].label}(${a.name})と${COACH_TEAM_META[teamKey].label}${COACH_ROLE_META[role].label}(${b.name})の配置を入れ替えました。`, 'good');
    selectedCoachSlot = null;
    save();
  }
  render();
}

function renderCoachSlot(teamKey, role) {
  const meta = COACH_ROLE_META[role];
  const c = state.club.coaches[teamKey][role];
  const isSelected = !!selectedCoachSlot && selectedCoachSlot.teamKey === teamKey && selectedCoachSlot.role === role;
  const nearRetire = c.age >= 58;
  return `
    <div class="stat-card coach-card${isSelected ? ' selected' : ''}" onclick="Game.selectCoachSlot('${teamKey}','${role}')">
      <div class="label">${meta.label}</div>
      <div class="value" style="font-size:0.95rem;">${c.name}</div>
      <div class="pmeta" style="color:var(--text-dim);font-size:0.72rem;margin-top:4px;">年齢 ${c.age}${nearRetire ? ' ⚠定年間近' : ''} ｜ 能力 ${c.ability}</div>
    </div>
  `;
}

function renderCoaches() {
  const teamsHtml = COACH_TEAM_ORDER.filter(isCoachTeamOwned).map(teamKey => {
    const cards = COACH_ROLE_ORDER.map(role => renderCoachSlot(teamKey, role)).join('');
    return `
      <div class="panel">
        <h2>${COACH_TEAM_META[teamKey].label}</h2>
        <div class="grid-cards">${cards}</div>
      </div>
    `;
  }).join('');
  const hint = selectedCoachSlot
    ? `<div class="phase-banner">${COACH_TEAM_META[selectedCoachSlot.teamKey].label}「${COACH_ROLE_META[selectedCoachSlot.role].label}」を選択中 — 入れ替え先の枠をクリックしてください。(同じ枠を再クリックで選択解除)</div>`
    : `<p class="empty-note">監督は全体、個別コーチ(オフェンス/ディフェンス/GK/フィジカル/スピード)は能力値がそのまま該当パラメータの成長ボーナスに、アシスタントコーチ2人は監督より少し弱い形で全体に効きます(いずれも試合の戦術面にも小さく寄与)。監督・コーチは60歳で定年退任し、後任には能力の低い若手コーチが自動的に就任します。枠をクリックし、続けて別の枠をクリックすると、チーム・役職を問わず自由に配置を入れ替えられます。</p>`;
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>コーチ・監督人事</h2>
      ${hint}
    </div>
    ${teamsHtml}
  `;
}

// ---------- カップ戦(表示) ----------

let cupSubTab = 'league';
function setCupSubTab(tab) { cupSubTab = tab; render(); }

function cupTeamLabel(team, myId) {
  return team.id === myId ? `<b class="cup-me">${team.name}(自クラブ)</b>` : team.name;
}

function renderCupRound(round, myId) {
  const matchRows = round.matches.map(m => {
    const winnerIsHome = m.winner.id === m.home.id;
    if (m.meDetail) cupMatchDetailById[m.id] = m.meDetail;
    return `<div class="cup-match">
      <span class="${winnerIsHome ? 'cup-winner' : ''}">${cupTeamLabel(m.home, myId)}</span>
      <span class="cup-score">${m.homeGoals} - ${m.awayGoals}${m.penalties ? ' (PK)' : ''}</span>
      <span class="${!winnerIsHome ? 'cup-winner' : ''}">${cupTeamLabel(m.away, myId)}</span>
      ${m.meDetail ? `<button class="ghost-btn" style="padding:2px 8px;font-size:0.68rem;" onclick="Game.watchCupMatch('${m.id}')">📺観戦</button>` : ''}
    </div>`;
  }).join('');
  const byeRows = round.byes.map(t => `<div class="cup-match cup-bye">${cupTeamLabel(t, myId)} ｜ 不戦勝で次ラウンドへ</div>`).join('');
  return `<h3>${round.label} (${round.sizeBefore}チーム)</h3>${matchRows}${byeRows}`;
}

function renderCupBracket(rounds, myId) {
  return rounds.map(r => renderCupRound(r, myId)).join('');
}

// リーグカップ/大陸カップ/ワールドクラブカップ共通: シーズン中は節が来るたびに段階的に
// ラウンドが増えていくため、「次はいつ消化されるか」「現時点で敗退済みか」を案内文で明示する。
function renderScheduledCupBody(cup, label, scheduleWeeks) {
  let progress;
  if (cup.finished) {
    progress = cup.myResult.champion
      ? `🏆 今シーズンの${label}で優勝しました！`
      : `${cup.myResult.roundLabel}で敗退しました。(${cup.roundsWon}回戦突破)`;
  } else if (cup.myResult) {
    progress = `${cup.myResult.roundLabel}で敗退しました。(残りラウンドは他クラブのみで進行します)`;
  } else {
    const nextWeek = scheduleWeeks[cup.nextIdx];
    progress = nextWeek != null ? `第${nextWeek + 1}節終了後に次のラウンドが行われます。` : '';
  }
  const championText = cup.finished ? `優勝クラブ: ${cup.champion.name}${cup.champion.id === 'me' ? '(自クラブ)' : ''}` : '優勝クラブ: 未定';
  return `
    <div class="panel">
      <h2>${label}</h2>
      <p class="empty-note">自クラブの成績: ${progress} ｜ ${championText}</p>
      ${cup.rounds.length ? renderCupBracket(cup.rounds, 'me') : '<div class="empty-note">まだ1ラウンドも消化されていません。</div>'}
    </div>
  `;
}

function renderLeagueCupTab() {
  const cup = state.leagueCup;
  if (!cup) return '<div class="empty-note">今シーズンのリーグカップはまだ開催されていません(シーズン開始時に自動開催されます)。</div>';
  return renderScheduledCupBody(cup, `リーグカップ — ${cup.tierName}`, LEAGUE_CUP_SCHEDULE);
}

function renderWorldCupTab() {
  const cup = state.worldCup;
  if (!cup) return '<div class="empty-note">今シーズンのワールドピラミッドカップはまだ開催されていません(シーズン開始時に自動開催されます)。</div>';
  const r = cup.myResult;
  let summary;
  if (r) {
    summary = r.champion
      ? '🌍🏆 全ティアを勝ち上がり、ワールドピラミッドカップで優勝しました！'
      : `${r.eliminatedAt.tierIdx === 'final' ? '決勝ステージ' : TIERS[r.eliminatedAt.tierIdx].name + 'ステージ'}の${r.eliminatedAt.roundLabel}で敗退(通算${r.stagesWonTotal}勝 ／ ${r.tiersCleared}ティア突破)`;
  } else if (cup.eliminatedAt) {
    summary = `${cup.eliminatedAt.tierIdx === 'final' ? '決勝ステージ' : TIERS[cup.eliminatedAt.tierIdx].name + 'ステージ'}の${cup.eliminatedAt.roundLabel}で敗退しました。(残りは他クラブのみで進行中 ／ 通算${cup.stagesWonTotal}勝 ／ ${cup.tiersCleared}ティア突破)`;
  } else {
    summary = `勝ち進み中です。(通算${cup.stagesWonTotal}勝 ／ ${cup.tiersCleared}ティア突破)`;
  }

  const enteredHtml = [];
  const notEnteredHtml = [];
  cup.stages.forEach(stage => {
    if (stage.meEntered) {
      enteredHtml.push(`<div class="panel"><h2>${stage.tierName}ステージ</h2>${renderCupBracket(stage.rounds, 'me')}</div>`);
    } else {
      const winnerNames = stage.winners.map(w => w.name).join('、');
      notEnteredHtml.push(`<div class="stat-card"><div class="label">${stage.tierName}ステージ</div><div class="pmeta" style="color:var(--text-dim);font-size:0.75rem;margin-top:6px;">勝ち上がり4クラブ: ${winnerNames}</div></div>`);
    }
  });
  const activeHtml = cup.activeStage
    ? `<div class="panel"><h2>${TIERS[cup.activeStage.tierIdx].name}ステージ (進行中)</h2>${cup.activeStage.rounds.length ? renderCupBracket(cup.activeStage.rounds, 'me') : '<div class="empty-note">まだ1ラウンドも消化されていません。</div>'}</div>`
    : '';
  const finalHtml = cup.finalStage
    ? `<div class="panel"><h2>決勝ステージ (Final 4)</h2>${cup.finalStage.rounds.length ? renderCupBracket(cup.finalStage.rounds, 'me') : '<div class="empty-note">まだ1ラウンドも消化されていません。</div>'}</div>`
    : '';

  return `
    <div class="panel">
      <h2>ワールドピラミッドカップ</h2>
      <p class="empty-note">最下層ティアの20クラブから4クラブが勝ち上がり、1つ上のティアの20クラブと合流してまた4クラブが勝ち上がる…という形で全ティアを貫くカップ戦です。自クラブは所属ティアのステージから登場し、勝ち進むほど上位ティアのクラブとも戦うことになります。</p>
      <p class="empty-note">自クラブの成績: ${summary} ｜ ${cup.finished ? `優勝クラブ: ${cup.champion.name}${cup.champion.id === 'me' ? '(自クラブ)' : ''}` : '優勝クラブ: 未定'}</p>
    </div>
    ${enteredHtml.join('')}
    ${activeHtml}
    ${notEnteredHtml.length ? `<div class="panel"><h2>他ティアのステージ結果</h2><div class="grid-cards">${notEnteredHtml.join('')}</div></div>` : ''}
    ${finalHtml}
  `;
}

// クラブランクが基準に届いていない場合の案内文。届いていればnullを返す。
function rankCupStatusNote(cup, minStage, label) {
  if (cup) return null;
  return `<div class="empty-note">クラブランクが基準(${CLUB_RANK_STAGES[minStage].label}以上)に届いていないため、今シーズンは${label}に出場していません。クラブランクを上げると次シーズンから自動的に出場します。</div>`;
}

function renderRankCupTab(cup, minStage, label, scheduleWeeks) {
  const note = rankCupStatusNote(cup, minStage, label);
  if (note) return note;
  return renderScheduledCupBody(cup, label, scheduleWeeks);
}

// ---- 大陸チャンピオンズカップ(表示) ----

function renderChampCupQualify(cup) {
  if (!cup.qualifyRound) return '';
  return `<div class="panel"><h2>予選</h2>${renderCupRound(cup.qualifyRound, 'me')}</div>`;
}

function renderChampCupLeagueTable(cup) {
  if (!cup.leagueTable) return '';
  const rows = cup.leagueTable.map((t, i) => {
    const pos = i + 1;
    const cls = [t.id === 'me' ? 'me' : '', pos <= 4 ? 'promo' : ''].filter(Boolean).join(' ');
    return `<tr class="${cls}">
      <td>${pos}</td>
      <td class="name-col">${t.name}${t.id === 'me' ? ' (自クラブ)' : ''}</td>
      <td>${t.played}</td><td>${t.win}</td><td>${t.draw}</td><td>${t.lose}</td>
      <td>${t.gf}</td><td>${t.ga}</td><td>${t.gd > 0 ? '+' : ''}${t.gd}</td>
      <td><b>${t.pts}</b></td>
    </tr>`;
  }).join('');
  return `<div class="panel">
    <h2>リーグフェーズ順位表</h2>
    <p class="empty-note">上位4クラブが決勝トーナメントへ進出します。</p>
    <div style="overflow-x:auto;"><table><thead><tr><th>順位</th><th class="name-col">クラブ名</th><th>試</th><th>勝</th><th>分</th><th>負</th><th>得</th><th>失</th><th>差</th><th>勝点</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function renderChampCupLeagueLog(cup) {
  if (!cup.leagueLog.length) return '';
  const rows = cup.leagueLog.map((m, i) => {
    const id = `champ-league-${i}`;
    cupMatchDetailById[id] = m;
    const resultText = m.result === 'win' ? '勝利' : m.result === 'draw' ? '引き分け' : '敗北';
    return `<div class="cup-match">
      <span>第${m.round}節 ${m.isHome ? '(H)' : '(A)'} vs ${m.oppName}</span>
      <span class="cup-score">${m.myGoals} - ${m.oppGoals} ${resultText}</span>
      <button class="ghost-btn" style="padding:2px 8px;font-size:0.68rem;" onclick="Game.watchCupMatch('${id}')">📺観戦</button>
    </div>`;
  }).join('');
  return `<div class="panel"><h2>リーグフェーズ 対戦結果</h2>${rows}</div>`;
}

function renderChampCupKnockout(cup) {
  if (!cup.knockoutRounds.length) return '';
  return `<div class="panel"><h2>決勝トーナメント</h2>${renderCupBracket(cup.knockoutRounds, 'me')}</div>`;
}

function renderChampionsCupTab() {
  const cup = state.champCup;
  if (!cup) {
    return `<div class="empty-note">所属ティアが${TIERS[CHAMPIONS_CUP_MIN_TIER].name}(L${CHAMPIONS_CUP_MIN_TIER + 1})以上に到達していないため、今シーズンは大陸チャンピオンズカップに出場していません。昇格すると次シーズンから自動的に出場します。</div>`;
  }
  let summary;
  if (cup.finished) {
    if (cup.myResult.champion) summary = '🏆 今シーズンの大陸チャンピオンズカップで優勝しました！';
    else if (cup.eliminatedAt.stage === 'qualify') summary = '予選で敗退しました。';
    else if (cup.eliminatedAt.stage === 'league') summary = `リーグフェーズ${cup.eliminatedAt.position}位で決勝トーナメント進出を逃しました。`;
    else summary = `${cup.eliminatedAt.roundLabel}で敗退しました。(${cup.stagesWonTotal}回戦突破)`;
  } else {
    const phaseLabel = cup.phase === 'qualify' ? '予選' : cup.phase === 'league' ? 'リーグフェーズ' : '決勝トーナメント';
    summary = `${phaseLabel}を戦っています。`;
  }
  const championText = cup.finished && cup.champion ? `優勝クラブ: ${cup.champion.name}${cup.champion.id === 'me' ? '(自クラブ)' : ''}` : '優勝クラブ: 未定';
  const entryText = cup.meDirect ? 'クラブランクが基準に届いているため、予選免除でリーグフェーズへ直接出場しました。' : '予選から勝ち上がっての出場です。';
  return `
    <div class="panel">
      <h2>大陸チャンピオンズカップ</h2>
      <p class="empty-note">${TIERS[CHAMPIONS_CUP_MIN_TIER].name}以上のクラブだけが参加できる最上位の通期カップ戦です。予選(ノックアウト)→リーグフェーズ(8クラブ総当たり)→決勝トーナメント(上位4クラブ)という一連の流れで、大陸カップに代わってシーズンを通じて戦います。</p>
      <p class="empty-note">${entryText}</p>
      <p class="empty-note">自クラブの成績: ${summary} ｜ ${championText}</p>
    </div>
    ${renderChampCupQualify(cup)}
    ${renderChampCupLeagueTable(cup)}
    ${renderChampCupLeagueLog(cup)}
    ${renderChampCupKnockout(cup)}
  `;
}

// 下部組織カップ(2軍以下/ユース以下)タブの本体。チーム切り替えナブ(トップを除く)+
// 選んだチームのカップを、トップの各カップと同じ汎用renderScheduledCupBody()で表示する。
function renderAcademyCupTab() {
  const tabs = availableLeagueViewTabs().filter(t => t.key !== 'top');
  if (!tabs.length) return '<div class="empty-note">下部組織のチームをまだ所持していません。「施設」タブの「ユース組織」でチームを新設してください。</div>';
  if (!tabs.some(t => t.key === leagueViewTab)) leagueViewTab = tabs[0].key;
  const nav = renderLeagueViewNav(tabs, leagueViewTab, 'setLeagueViewTab');
  const key = leagueViewTab;
  const cup = state.club.academyCups[key];
  const body = cup
    ? renderScheduledCupBody(cup, `${academyLeagueLabel(key)}カップ — ${cup.tierName}`, LEAGUE_CUP_SCHEDULE)
    : `<div class="empty-note">${academyWaitingNote(key) || 'まだカップ戦が開催されていません。'}</div>`;
  return `${nav}${body}`;
}

function renderCup() {
  const subNav = `
    <div class="sub-tabs" style="margin-bottom:14px;">
      <button class="sub-tab-btn ${cupSubTab === 'league' ? 'active' : ''}" onclick="Game.setCupSubTab('league')">リーグカップ</button>
      <button class="sub-tab-btn ${cupSubTab === 'world' ? 'active' : ''}" onclick="Game.setCupSubTab('world')">ワールドピラミッドカップ</button>
      <button class="sub-tab-btn ${cupSubTab === 'continental' ? 'active' : ''}" onclick="Game.setCupSubTab('continental')">大陸カップ</button>
      <button class="sub-tab-btn ${cupSubTab === 'champions' ? 'active' : ''}" onclick="Game.setCupSubTab('champions')">大陸チャンピオンズカップ</button>
      <button class="sub-tab-btn ${cupSubTab === 'worldClub' ? 'active' : ''}" onclick="Game.setCupSubTab('worldClub')">ワールドクラブカップ</button>
      <button class="sub-tab-btn ${cupSubTab === 'academy' ? 'active' : ''}" onclick="Game.setCupSubTab('academy')">下部組織カップ</button>
    </div>`;
  let body;
  if (cupSubTab === 'world') body = renderWorldCupTab();
  else if (cupSubTab === 'continental') {
    body = state.club.tier >= CHAMPIONS_CUP_MIN_TIER
      ? `<div class="empty-note">${TIERS[CHAMPIONS_CUP_MIN_TIER].name}へ到達したため、大陸カップは「大陸チャンピオンズカップ」タブに引き継がれました。</div>`
      : renderRankCupTab(state.continentalCup, CONTINENTAL_CUP_MIN_RANK_STAGE, '大陸カップ', CONTINENTAL_CUP_SCHEDULE);
  }
  else if (cupSubTab === 'champions') body = renderChampionsCupTab();
  else if (cupSubTab === 'worldClub') body = renderRankCupTab(state.worldClubCup, WORLD_CLUB_CUP_MIN_RANK_STAGE, 'ワールドクラブカップ', WORLD_CLUB_CUP_SCHEDULE);
  else if (cupSubTab === 'academy') body = renderAcademyCupTab();
  else body = renderLeagueCupTab();
  document.getElementById('content').innerHTML = `${subNav}${body}`;
}

// 現在の試合観戦モーダルの再生タイマー・コールバック(モジュール単位で1件だけ保持)。
let mvTimer = null;
let mvOnDone = null;
let mvSkipFn = null;

const MV_EVENT_ICON = { goal: '⚽', yellow: '🟨', red: '🟥', injury: '🩹' };
function mvTeamTag(ev) {
  return `<span class="mv-team-tag mv-team-tag-${ev.team}">${ev.team === 'me' ? '自' : '相手'}</span>`;
}
function mvEventLabel(ev) {
  const who = ev.team === 'me' ? `<b>${ev.name}</b>` : ev.name;
  if (ev.type === 'goal') return `${who} が得点！`;
  if (ev.type === 'yellow') return `${who} にイエローカード`;
  if (ev.type === 'red') return `${who} に${ev.detail === '2枚目の警告' ? '2枚目のイエロー、' : ''}レッドカードで退場`;
  if (ev.type === 'injury') return `${who} が負傷 (${INJURY_LABEL[ev.severity]})`;
  return '';
}
function mvMinuteLabel(minute) {
  return minute > 90 ? `90+${minute - 90}` : `${minute}`;
}

// detail: {competition, round, isHome, oppName, myGoals, oppGoals, result, events, penalties?, wonPenalties?}
// onDone: 再生が終わって「閉じる/次の試合へ」を押したときに呼ぶコールバック(省略時はrender)。
function openMatchViewer(detail, onDone) {
  mvOnDone = onDone || render;
  const el = document.getElementById('matchViewer');
  const events = detail.events;
  let minute = 0;
  let idx = 0;
  let myScore = 0, oppScore = 0;
  const feedItems = [];
  const teamName = state.club.name;
  // 自チームは常に画面左側に固定表示する(ホーム/アウェーの違いはH/Aタグのみで示す)。
  const myHaTag = detail.isHome ? 'H' : 'A';
  const oppHaTag = detail.isHome ? 'A' : 'H';

  function currentScoreLine() {
    return `${myScore} - ${oppScore}`;
  }

  function renderFrame(finished) {
    el.innerHTML = `
      <div class="match-viewer-box">
        <div class="mv-header">
          <div class="mv-competition">${detail.competition || ''}${detail.round ? ` 第${detail.round}節` : ''}</div>
          <div class="mv-teams">
            <span class="mv-team-me">${teamName}<span class="mv-ha">${myHaTag}</span></span>
            <span>vs</span>
            <span class="mv-team-opp">${detail.oppName}<span class="mv-ha">${oppHaTag}</span></span>
          </div>
          <div class="mv-score">${currentScoreLine()}</div>
          <div class="mv-clock">${finished ? '試合終了' : mvMinuteLabel(minute) + '分'}</div>
          <div class="mv-pitch-bar"><div class="mv-pitch-fill" style="width:${clamp(minute / 93 * 100, 0, 100).toFixed(0)}%"></div></div>
        </div>
        <div class="mv-feed" id="mvFeed">${feedItems.join('') || '<div class="empty-note">キックオフ。</div>'}</div>
        <div class="mv-footer">
          ${finished ? '' : '<button class="ghost-btn" onclick="Game.skipMatchViewer()">早送りして結果を見る</button>'}
          <button class="secondary-btn" onclick="Game.closeMatchViewer()">${finished ? (mvOnDone === render ? '閉じる' : '次の試合へ') : '中断して閉じる'}</button>
        </div>
      </div>`;
    const feed = document.getElementById('mvFeed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  function finish() {
    if (mvTimer) { clearInterval(mvTimer); mvTimer = null; }
    if (detail.penalties) {
      feedItems.push(`<div class="mv-event final">PK戦の末、${detail.wonPenalties ? '勝利しました！' : '敗れました…'}</div>`);
    } else {
      const outcome = detail.result === 'win' ? '勝利！' : detail.result === 'draw' ? '引き分け' : '敗北…';
      feedItems.push(`<div class="mv-event final">試合終了 ${currentScoreLine()} ${outcome}</div>`);
    }
    renderFrame(true);
  }

  function tick() {
    minute++;
    while (idx < events.length && events[idx].minute <= minute) {
      const ev = events[idx];
      if (ev.type === 'goal') { if (ev.team === 'me') myScore++; else oppScore++; }
      feedItems.push(`<div class="mv-event ${ev.type} mv-event-${ev.team}"><span class="mv-min">${mvMinuteLabel(ev.minute)}'</span>${mvTeamTag(ev)}<span>${MV_EVENT_ICON[ev.type]} ${mvEventLabel(ev)}</span></div>`);
      idx++;
    }
    if (minute >= 93) { finish(); return; }
    renderFrame(false);
  }

  mvSkipFn = () => { while (minute < 93) tick(); };

  el.classList.remove('hidden');
  renderFrame(false);
  // 1分=約100msで進行(従来の3倍速。90分を約9秒で消化する早見再生)。
  mvTimer = setInterval(tick, 100);
}

function skipMatchViewer() {
  if (mvSkipFn) mvSkipFn();
}

function closeMatchViewer() {
  if (mvTimer) { clearInterval(mvTimer); mvTimer = null; }
  document.getElementById('matchViewer').classList.add('hidden');
  const done = mvOnDone;
  mvOnDone = null;
  mvSkipFn = null;
  if (done) done();
}

// カップ戦のブラケットに表示されている「観戦」ボタンから、その試合のmeDetailを引く
// ための一時レジストリ(状態自体はrenderCupRound()が描画のたびに詰め直す)。
let cupMatchDetailById = {};
function watchCupMatch(id) {
  const detail = cupMatchDetailById[id];
  if (detail) openMatchViewer(detail, render);
}

// アカデミー(下部組織)タブで、どのリーグの試合結果を開いているか。
let expandedLeagueLog = null;
function toggleLeagueLog(key) {
  expandedLeagueLog = expandedLeagueLog === key ? null : key;
  render();
}

function renderStats() {
  const order = { GK: 0, DF: 1, MF: 2, FW: 3 };
  const rows = [...state.club.players]
    .map(p => ({ p, st: state.club.seasonStats[p.id] || { goals: 0, yellow: 0, red: 0, injuries: 0, apps: 0, ratingSum: 0 } }))
    .filter(r => r.st.apps > 0)
    .sort((a, b) => b.st.goals - a.st.goals || b.st.apps - a.st.apps || order[a.p.pos] - order[b.p.pos]);

  const statRows = rows.map(({ p, st }) => `
    <tr>
      <td class="name-col"><span class="pos-badge pos-${p.pos}">${p.pos}</span> ${p.name}</td>
      <td>${st.apps}</td><td>${st.goals}</td><td>${((st.ratingSum || 0) / st.apps).toFixed(2)}</td><td>${st.yellow}</td><td>${st.red}</td><td>${st.injuries}</td>
    </tr>
  `).join('');

  const matchRows = [...state.topMatchLog].reverse().map(m => `
    <div class="cup-match">
      <span>第${m.round}節 ${m.isHome ? '(H)' : '(A)'} vs ${m.oppName}</span>
      <span class="cup-score">${m.myGoals} - ${m.oppGoals}</span>
      <span class="${m.result === 'win' ? 'cup-winner cup-me' : ''}">${m.result === 'win' ? '勝' : m.result === 'draw' ? '分' : '負'}</span>
      <button class="ghost-btn" style="padding:2px 8px;font-size:0.68rem;" onclick="Game.watchTopMatch(${state.topMatchLog.indexOf(m)})">📺観戦</button>
    </div>
  `).join('');

  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h2>シーズンスタッツ — 得点・カード</h2>
      <p class="empty-note">シーズン${state.season}(全試合・全大会通算)の出場記録です。出場のあった選手のみ表示します。平均個人スコアは基準6.5点に得点・カード・その試合の勝敗を加減した1試合ごとの採点(5.0〜10.0)の平均です。</p>
      ${rows.length ? `<div style="overflow-x:auto;"><table><thead><tr><th class="name-col">選手</th><th>出場</th><th>得点</th><th>平均個人スコア</th><th>🟨</th><th>🟥</th><th>負傷</th></tr></thead><tbody>${statRows}</tbody></table></div>` : '<div class="empty-note">まだ出場記録がありません。</div>'}
    </div>
    <div class="panel">
      <h2>リーグ戦 試合結果</h2>
      <p class="empty-note">「観戦」から、その試合の経過をもう一度見返せます。下部組織(2軍・ユース等)の結果は「アカデミー」タブから確認できます。カップ戦の結果は「カップ戦」タブから確認できます。</p>
      ${matchRows || '<div class="empty-note">まだ試合がありません。</div>'}
    </div>
  `;
}

function watchTopMatch(idx) {
  const detail = state.topMatchLog[idx];
  if (detail) openMatchViewer(detail, render);
}

// ============================================================================
// クラブ記録・マイルストーン(企画書12.4 / 柱3) ─ 達成の可視化・報酬化
// ----------------------------------------------------------------------------
// 「昇格するたびに新しい部屋が開き、常に次の目標が見え、達成が可視化・報酬化される」
// 状態を全10ティアで維持するための仕組み。達成閾値はステップ制の絶対値で広く刻むため、
// 賞金カーブが指数的に伸びる本作では自然に全ティアへ分散する。
// 報酬は「小さな恒久収入ボーナス」(合計上限あり)で、成長サイクル(1.2)に直結させる。
// ============================================================================

const MILESTONE_BONUS_CAP = 25; // 恒久収入ボーナスの合計上限(%)
const MILESTONE_STEP_LABELS = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function initClubRecords() {
  return {
    milestones: {},           // "defId:stepIndex" -> { season }
    history: [],               // クラブ史(達成の年代記)
    bonusPct: 0,               // 恒久収入ボーナスの合計(%)
    bests: { money: 0, attendance: 0, seasonPoints: 0, seasonWins: 0 },
    championships: 0,          // リーグ優勝(1位)回数
    surpassedRivals: [],       // 戦力・ティアとも上回ったライバルのid
    hallOfFame: [],            // 選手の殿堂(企画書12.8): { uid, name, pos, overall, age, tierName, reason, season }
  };
}

// ダッシュボードと同じ推定観客数(stadiumCapacity × attendanceFactor)。
function estimatedTopAttendance() {
  return Math.round(stadiumCapacity('top') * attendanceFactor(state.club.reputation));
}

function rivalStrengthStable(rival, category) {
  const tierIdx = rival.tiers[category];
  return Math.round(rivalBaseline(category, tierIdx) + TIER_HALF_WIDTH[tierIdx] * RIVAL_STRENGTH_RATIO);
}

function recordsBonusMult() {
  const pct = (state.club.records && state.club.records.bonusPct) || 0;
  return 1 + pct / 100;
}

// マイルストーン定義。value():現在値, steps:[{v:閾値, bonus:%}], fmt:表示整形。
const MILESTONE_DEFS = [
  {
    id: 'tier', name: 'リーグ到達',
    value: () => state.club.tier,
    // L2〜L10 の各初到達(tier index 1〜9)
    steps: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(t => ({ v: t, bonus: 0.5, label: TIERS[t].name })),
    fmt: (v) => TIERS[v] ? TIERS[v].name : `L${v + 1}`,
  },
  {
    id: 'rank', name: 'クラブランク', value: () => computeClubRank().score,
    steps: [100, 250, 450, 650, 850, 1000].map(v => ({ v, bonus: 0.3 })),
    fmt: (v) => `スコア ${v}`,
  },
  {
    id: 'money', name: '総資産', value: () => Math.max(state.club.money, state.club.records.bests.money),
    steps: [500, 3000, 20000, 150000, 1000000, 8000000].map(v => ({ v, bonus: 0.3 })),
    fmt: (v) => fmtMoney(v),
  },
  {
    id: 'affiliates', name: '提携網', value: () => state.club.affiliates.length,
    steps: [1, 2, 3, 5, 7, 10].map(v => ({ v, bonus: 0.4 })),
    fmt: (v) => `${v}クラブ`,
  },
  {
    id: 'graduates', name: '育成輩出', value: () => (state.club.developmentStats.graduatesToTop || 0),
    steps: [1, 5, 15, 30, 60, 100].map(v => ({ v, bonus: 0.5 })),
    fmt: (v) => `トップ昇格 ${v}人`,
  },
  {
    id: 'attendance', name: '観客動員', value: () => Math.max(estimatedTopAttendance(), state.club.records.bests.attendance),
    steps: [1000, 3000, 10000, 30000, 80000, 150000].map(v => ({ v, bonus: 0.3 })),
    fmt: (v) => `${v.toLocaleString()}人`,
  },
  {
    id: 'titles', name: '栄冠', value: () => (state.club.records.championships || 0),
    steps: [1, 3, 5, 10, 20].map(v => ({ v, bonus: 0.3 })),
    fmt: (v) => `リーグ優勝 ${v}回`,
  },
  {
    id: 'points', name: '最多勝点', value: () => state.club.records.bests.seasonPoints,
    steps: [50, 70, 85, 95, 105].map(v => ({ v, bonus: 0.3 })),
    fmt: (v) => `シーズン勝点 ${v}`,
  },
];

// 現時点で既に満たしているマイルストーンを「基準値」として静かに既達扱いにする(恒久ボーナス・
// ログ・クラブ史への追加はしない)。新規ゲーム開始時・既存セーブ読込時に一度だけ呼び、
// 「ここから先の前進」だけが祝福・報酬対象になるようにする。
function seedMilestonesBaseline() {
  const r = state.club.records;
  if (!r) return;
  r.bests.money = Math.max(r.bests.money || 0, state.club.money);
  r.bests.attendance = Math.max(r.bests.attendance || 0, estimatedTopAttendance());
  const st = state.standings && state.standings['me'];
  if (st) {
    r.bests.seasonPoints = Math.max(r.bests.seasonPoints || 0, st.pts || 0);
    r.bests.seasonWins = Math.max(r.bests.seasonWins || 0, st.win || 0);
  }
  MILESTONE_DEFS.forEach(def => {
    const cur = def.value();
    def.steps.forEach((step, i) => {
      const key = `${def.id}:${i}`;
      if (!r.milestones[key] && cur >= step.v) r.milestones[key] = { season: state.season, baseline: true };
    });
  });
  RIVAL_CLUBS.forEach(rv => {
    if (!r.surpassedRivals.includes(rv.id) &&
        state.club.tier > rv.tiers.top &&
        teamStrength(state.club.players) > rivalStrengthStable(rv, 'top')) {
      r.surpassedRivals.push(rv.id);
    }
  });
}

// マイルストーン達成判定。playRound()末(シーズン中)と endSeason()末(シーズン成績)で呼ぶ。
function checkMilestones() {
  const r = state.club.records;
  if (!r) return;
  // 過去最高値(bests)の更新。
  r.bests.money = Math.max(r.bests.money || 0, state.club.money);
  r.bests.attendance = Math.max(r.bests.attendance || 0, estimatedTopAttendance());
  const st = state.standings && state.standings['me'];
  if (st) {
    r.bests.seasonPoints = Math.max(r.bests.seasonPoints || 0, st.pts || 0);
    r.bests.seasonWins = Math.max(r.bests.seasonWins || 0, st.win || 0);
  }

  let achieved = 0;
  MILESTONE_DEFS.forEach(def => {
    const cur = def.value();
    def.steps.forEach((step, i) => {
      const key = `${def.id}:${i}`;
      if (r.milestones[key]) return;
      if (cur >= step.v) {
        r.milestones[key] = { season: state.season };
        r.bonusPct = Math.min(MILESTONE_BONUS_CAP, Math.round((r.bonusPct + step.bonus) * 10) / 10);
        const tierLabel = step.label || MILESTONE_STEP_LABELS[i] || `${i + 1}`;
        r.history.push({ season: state.season, text: `${def.name}「${tierLabel}」— ${def.fmt(step.v)}` });
        addLog(`🏅 マイルストーン達成: ${def.name}「${tierLabel}」(${def.fmt(step.v)})　恒久ボーナス 収入+${step.bonus}%`, 'gold');
        achieved++;
      }
    });
  });

  // 超えたライバルの記録(戦力・所属ティアの両方で上回ったら「超えた」)。
  const myTier = state.club.tier;
  const myStr = teamStrength(state.club.players);
  RIVAL_CLUBS.forEach(rv => {
    if (r.surpassedRivals.includes(rv.id)) return;
    if (myTier > rv.tiers.top && myStr > rivalStrengthStable(rv, 'top')) {
      r.surpassedRivals.push(rv.id);
      r.history.push({ season: state.season, text: `強豪 ${rv.name} を戦力・格ともに上回った` });
      addLog(`🔥 ${rv.name} を戦力・所属リーグともに上回りました。`, 'gold');
    }
  });

  if (achieved > 0) toast(`🏅 マイルストーンを${achieved}件達成！(ダッシュボードで確認)`);
  if (r.history.length > 120) r.history = r.history.slice(-120);
}

// ============================================================================
// 選手の殿堂(企画書12.8) ─ 育てた/率いた選手が「ここにいた証」を残す
// ----------------------------------------------------------------------------
// 閾値は絶対値ではなく「今のティアの目安上限」(TIER_BASELINE+TIER_HALF_WIDTH)からの
// 相対値にする(12.4のマイルストーンと同じ考え方)。これにより、地域アマチュアで生まれた
// 初期の看板選手も、ワールドスーパーリーグの世界的スターも、同じ基準で"一流"と評価できる。
// ============================================================================

function hallOfFameBar() {
  const t = state.club.tier;
  return TIER_BASELINE[t] + TIER_HALF_WIDTH[t];
}
function isHallOfFameWorthy(p) { return p && p.overall >= hallOfFameBar(); }

// 引退・移籍・引き抜きなど「クラブを去る」瞬間に呼ぶ。基準に満たなければ何もしない。
function inductHallOfFame(p, reason) {
  const r = state.club.records;
  if (!r || !isHallOfFameWorthy(p)) return;
  if (r.hallOfFame.some(h => h.uid === p.id)) return; // 同一選手の重複登録を防ぐ
  r.hallOfFame.unshift({
    uid: p.id, name: p.name, pos: p.pos, overall: p.overall, age: p.age,
    tierName: TIERS[state.club.tier].name, reason, season: state.season,
  });
  if (r.hallOfFame.length > 40) r.hallOfFame.length = 40;
  addLog(`🌟 殿堂入り: ${p.name}（${reason} ／ OVR ${p.overall}）`, 'gold');
  r.history.push({ season: state.season, text: `${p.name} が殿堂入り（${reason}）` });
}

// ダッシュボード用: 殿堂入り選手の一覧。
function renderHallOfFamePanel() {
  const r = state.club.records;
  if (!r) return '';
  const rows = r.hallOfFame.slice(0, 12).map(h => `
    <div class="player-card">
      <div class="player-info">
        <span class="pname"><span class="pos-badge pos-${h.pos}">${h.pos}</span> ${h.name}</span>
        <span class="pmeta">OVR ${h.overall} ｜ 最終所属時 ${h.tierName} ｜ ${h.reason} ｜ S${h.season}</span>
      </div>
    </div>
  `).join('');
  return `
    <div class="panel">
      <h2>選手の殿堂 <span style="font-size:0.75rem;color:var(--text-dim);font-weight:normal;">${r.hallOfFame.length}名</span></h2>
      <p class="empty-note">その時点のリーグ級で一流と呼べる水準に達した選手が、引退・移籍・引き抜きでクラブを去るときに殿堂入りします。</p>
      ${rows || '<div class="empty-note">まだ殿堂入りした選手はいません。エースを育て上げましょう。</div>'}
    </div>
  `;
}

// ダッシュボード用: マイルストーンの進捗・恒久ボーナス・次の目標・クラブ史。
function renderRecordsPanel() {
  const r = state.club.records;
  if (!r) return '';
  let total = 0, done = 0;
  const upcoming = [];
  MILESTONE_DEFS.forEach(def => {
    const cur = def.value();
    def.steps.forEach((step, i) => {
      total++;
      const key = `${def.id}:${i}`;
      if (r.milestones[key]) { done++; return; }
      const ratio = step.v > 0 ? clamp(cur / step.v, 0, 1) : 0;
      upcoming.push({ name: def.name, label: step.label || MILESTONE_STEP_LABELS[i] || `${i + 1}`, target: def.fmt(step.v), cur, ratio, bonus: step.bonus });
    });
  });
  upcoming.sort((a, b) => b.ratio - a.ratio);
  const next = upcoming.slice(0, 4);

  const nextHtml = next.map(n => `
    <div style="margin:7px 0;">
      <div style="display:flex;justify-content:space-between;font-size:0.8rem;">
        <span>${n.name}「${n.label}」<span style="color:var(--text-dim);">→ ${n.target}</span></span>
        <span style="color:var(--text-dim);">収入+${n.bonus}% ｜ ${Math.round(n.ratio * 100)}%</span>
      </div>
      <div style="height:6px;background:var(--panel-2, #2a2f3a);border-radius:3px;overflow:hidden;margin-top:3px;">
        <div style="height:100%;width:${Math.round(n.ratio * 100)}%;background:var(--accent, #4da3ff);"></div>
      </div>
    </div>
  `).join('') || '<div class="empty-note">すべてのマイルストーンを達成しました。</div>';

  const historyHtml = r.history.slice(-6).reverse()
    .map(h => `<div class="log-item gold">S${h.season}: ${h.text}</div>`).join('')
    || '<div class="empty-note">まだ達成記録がありません。</div>';

  return `
    <div class="panel">
      <h2>クラブ記録・マイルストーン</h2>
      <div class="grid-cards">
        <div class="stat-card"><div class="label">達成マイルストーン</div><div class="value">${done} / ${total}</div></div>
        <div class="stat-card"><div class="label">恒久収入ボーナス</div><div class="value">+${(r.bonusPct || 0).toFixed(1)}%<span style="font-size:0.7rem;color:var(--text-dim);"> / +${MILESTONE_BONUS_CAP}%</span></div></div>
        <div class="stat-card"><div class="label">資金の過去最高</div><div class="value">${fmtMoney(r.bests.money || 0)}</div></div>
        <div class="stat-card"><div class="label">動員の過去最高</div><div class="value">${(r.bests.attendance || 0).toLocaleString()}人</div></div>
      </div>
      <h3 style="margin:14px 0 4px;font-size:0.9rem;">次の目標</h3>
      ${nextHtml}
      <h3 style="margin:14px 0 4px;font-size:0.9rem;">クラブ史</h3>
      <div class="log-list">${historyHtml}</div>
    </div>
  `;
}

// ダッシュボード用: 名前つき3ライバルとの比較 + 野心ラダー(企画書12.5)。
function renderRivalPanel() {
  const r = state.club.records;
  const myTier = state.club.tier;
  const myStr = teamStrength(state.club.players);

  const row = (rv) => {
    const rvTier = rv.tiers.top;
    const rvStr = rivalStrengthStable(rv, 'top');
    const surpassed = r && r.surpassedRivals.includes(rv.id);
    let status, color;
    if (surpassed) { status = '超えた'; color = 'var(--good, #5ad18a)'; }
    else if (myTier >= rvTier && myStr >= rvStr) { status = '並んだ'; color = 'var(--accent, #4da3ff)'; }
    else { status = '追う'; color = 'var(--text-dim)'; }
    const tierGap = myTier - rvTier;
    const tierGapText = tierGap === 0 ? '同格' : (tierGap > 0 ? `+${tierGap}` : `${tierGap}`);
    return `
      <tr>
        <td class="name-col">${rv.name}</td>
        <td>${TIERS[rvTier].name}<br><span style="font-size:0.7rem;color:var(--text-dim);">格差 ${tierGapText}</span></td>
        <td>${rvStr}<br><span style="font-size:0.7rem;color:var(--text-dim);">自 ${myStr.toFixed(0)}</span></td>
        <td style="color:${color};font-weight:bold;">${status}</td>
      </tr>
    `;
  };

  // 野心ラダー: 次に見える目標を2〜3個。
  const ladder = [];
  if (myTier < TIERS.length - 1) ladder.push(`「${TIERS[myTier + 1].name}」への昇格`);
  const affDef = MILESTONE_DEFS.find(d => d.id === 'affiliates');
  const nextAff = affDef.steps.find((s, i) => !(r && r.milestones[`affiliates:${i}`]));
  if (nextAff) ladder.push(`提携クラブ ${nextAff.v} クラブ`);
  const nextRival = [...RIVAL_CLUBS].sort((a, b) => a.tiers.top - b.tiers.top)
    .find(rv => !(r && r.surpassedRivals.includes(rv.id)));
  if (nextRival) ladder.push(`${nextRival.name} を戦力・格ともに上回る`);
  const gradDef = MILESTONE_DEFS.find(d => d.id === 'graduates');
  const nextGrad = gradDef.steps.find((s, i) => !(r && r.milestones[`graduates:${i}`]));
  if (nextGrad) ladder.push(`ユース出身をトップへ通算 ${nextGrad.v} 人`);

  return `
    <div class="panel">
      <h2>ライバル比較</h2>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th class="name-col">クラブ</th><th>所属リーグ</th><th>戦力目安</th><th>状況</th></tr></thead>
          <tbody>${RIVAL_CLUBS.map(row).join('')}</tbody>
        </table>
      </div>
      <h3 style="margin:14px 0 4px;font-size:0.9rem;">野心ラダー(次の目標)</h3>
      <div class="log-list">${ladder.slice(0, 4).map(t => `<div class="log-item">▶ ${t}</div>`).join('')}</div>
    </div>
  `;
}

// ============================================================================
// 拡張トラック(企画書12.2) ─ 昇格するたびに「新しい部屋」が開く手応え
// ----------------------------------------------------------------------------
// tierIdx(1〜9 = L2〜L10 への到達)ごとの「そのリーグ級のテーマ」。数値的な変化は
// expansionDeltas() が現在の実装から実値で算出する(テーマ文はあくまで方向性の提示)。
// ============================================================================

const EXPANSION_TRACK = {
  1: '市の代表クラブへ。下部組織チームと提携クラブを持てるようになり、多層クラブ経営が始まる。',
  2: '地方の中堅へ。提携枠が広がり、スカウト網の上限も伸びていく。',
  3: '地方の強豪へ。賞金規模が大きくなり、施設とアカデミーへ本格的に投資できる規模に。',
  4: 'プロの入口。リーグカップでの番狂わせと臨時賞金を狙える体力がつく。',
  5: '準プロ強豪。クラブランクが上がり、上位カップ(大陸カップ等)の出場圏が近づく。',
  6: '国のトップへ。複数の提携クラブを従える"クラブ帝国"を運営する規模。世界的スポンサーが視野に。',
  7: '大陸へ。海外ショップ展開が解放。大陸カップの舞台で戦う。',
  8: '大陸の名門。大陸チャンピオンズカップの出場対象クラブに。',
  9: '世界の頂点。IPライセンス(不労所得)が解放。育てた選手を世界へ送り出すクラブへ。',
};

// fromTier → toTier で実際に変わる数値・解放を、現在の実装から算出して文字列配列で返す。
function expansionDeltas(fromTier, toTier) {
  const out = [];
  const affFrom = AFFILIATE_MAX_BASE + fromTier * AFFILIATE_MAX_PER_TIER;
  const affTo = AFFILIATE_MAX_BASE + toTier * AFFILIATE_MAX_PER_TIER;
  if (affTo > affFrom) out.push(`提携クラブ枠  ${affFrom} → ${affTo}`);
  const scoutFrom = (fromTier + 1) * SCOUT_LEVELS_PER_TIER;
  const scoutTo = (toTier + 1) * SCOUT_LEVELS_PER_TIER;
  if (scoutTo > scoutFrom) out.push(`スカウト網の上限  Lv.${scoutFrom} → Lv.${scoutTo}(＋クラブランク段階)`);
  if (ECON[toTier] > ECON[fromTier]) out.push(`賞金・収入の規模  約 ×${ECON[fromTier]} → ×${ECON[toTier]}`);
  if (toTier >= 4 && fromTier < 4) out.push('スポンサー候補の顔ぶれが格上げされていく');
  if (toTier >= 7 && fromTier < 7) out.push('🔓 海外ショップ展開が解放される');
  if (toTier >= 8 && fromTier < 8) out.push('🔓 大陸チャンピオンズカップの出場対象に');
  if (toTier >= 9 && fromTier < 9) out.push('🔓 マスコット・IPライセンスが解放される');
  return out;
}

// 昇格直後、シーズンレビュー冒頭に出す「新フロンティア」パネル。
function renderNewFrontierPanel(toTier) {
  if (!EXPANSION_TRACK[toTier]) return '';
  const deltas = expansionDeltas(toTier - 1, toTier);
  return `
    <div class="panel" style="border-color:var(--gold,#e8c15a);">
      <h2>🚪 新フロンティア — ${TIERS[toTier].name}</h2>
      <p style="margin:4px 0 10px;font-size:0.9rem;line-height:1.7;">${EXPANSION_TRACK[toTier]}</p>
      ${deltas.length ? `<h3 style="font-size:0.85rem;margin:8px 0 4px;">このリーグ級で広がること</h3>
        <div class="log-list">${deltas.map(d => `<div class="log-item gold">${d}</div>`).join('')}</div>` : ''}
    </div>
  `;
}

// ダッシュボード常設: 「次のリーグで広がること」— 常に次の部屋が見える状態にする。
function renderNextLeaguePanel() {
  const t = state.club.tier;
  if (t >= TIERS.length - 1) {
    return `
      <div class="panel">
        <h2>拡張トラック</h2>
        <p class="empty-note">${TIERS[t].name} — ピラミッドの頂点に到達しています。</p>
      </div>`;
  }
  const next = t + 1;
  const deltas = expansionDeltas(t, next);
  return `
    <div class="panel">
      <h2>次のリーグで広がること <span style="font-size:0.75rem;color:var(--text-dim);font-weight:normal;">${TIERS[next].name}</span></h2>
      <p style="margin:2px 0 8px;font-size:0.83rem;color:var(--text-dim);line-height:1.6;">${EXPANSION_TRACK[next] || ''}</p>
      <div class="log-list">${deltas.length ? deltas.map(d => `<div class="log-item">${d}</div>`).join('') : '<div class="empty-note">昇格で賞金規模とスカウトの精度が上がります。</div>'}</div>
    </div>
  `;
}

// ============================================================================
// 週次意思決定(企画書12.6) ─ 節と節の間に小さなトレードオフを挟み、単調な連打を崩す
// ============================================================================

const DECISION_ROLL_CHANCE = 0.25;   // 条件を満たした節で決断が発生する確率(1シーズンで概ね5〜6回)
const DECISION_MIN_GAP = 3;          // 前回の決断から最低この節数は空ける

// トップチーム全員のコンディションを delta ぶん増減(0〜CONDITION_MAX でクランプ)。
function adjustTopCondition(delta) {
  state.club.players.forEach(p => { p.condition = clamp((p.condition ?? CONDITION_MAX) + delta, 0, CONDITION_MAX); });
}
function bumpReputation(delta) {
  state.club.reputation = clamp(state.club.reputation + delta, 0, reputationCapForTier(state.club.tier));
}
// 「そのティアの相場」でスケールした金額(econの平方根基準)。序盤〜終盤で体感を揃える。
function decisionMoney(base) {
  return Math.round(base * Math.sqrt(TIERS[state.club.tier].econ));
}

// 決断プール。each: { id, weight, available(), build() -> {title, desc, options:[{label, result, apply}]} }
const WEEKLY_DECISION_POOL = [
  {
    id: 'sponsorSpot', weight: 3, available: () => true,
    build: () => {
      const amt = decisionMoney(45);
      return {
        title: 'スポットスポンサーの打診',
        desc: `地元企業から「今節だけユニフォームに広告を出したい」と打診。受ければ ${fmtMoney(amt)} が入るが、節操がないと一部サポーターは冷める。`,
        options: [
          { label: `受ける (+${fmtMoney(amt)})`, result: `${fmtMoney(amt)} を得た。評判 -3`, apply: () => { state.club.money += amt; bumpReputation(-3); } },
          { label: '断る', result: '筋を通した。評判 +2', apply: () => { bumpReputation(2); } },
        ],
      };
    },
  },
  {
    id: 'trainingIntensity', weight: 3, available: () => true,
    build: () => ({
      title: '今週のトレーニング強度',
      desc: '強度を上げれば選手は疲れるが締まる。落とせば疲労を抜けるが緩む。',
      options: [
        { label: '追い込む', result: 'コンディション -6(全員)', apply: () => adjustTopCondition(-6) },
        { label: '軽めに調整', result: 'コンディション +6(全員)', apply: () => adjustTopCondition(6) },
      ],
    }),
  },
  {
    id: 'localEvent', weight: 2, available: () => true,
    build: () => {
      const cost = decisionMoney(25);
      return {
        title: '地域イベントへの出演依頼',
        desc: `商店街のお祭りにクラブとして参加してほしいと依頼。運営費 ${fmtMoney(cost)} はかかるが、地域の支持は確実に上がる。`,
        options: [
          { label: `参加する (-${fmtMoney(cost)})`, result: `${fmtMoney(cost)} を拠出。評判 +5`, apply: () => { state.club.money -= cost; bumpReputation(5); } },
          { label: '今回は見送る', result: '練習に集中した。', apply: () => {} },
        ],
      };
    },
  },
  {
    id: 'facilityGlitch', weight: 2, available: () => true,
    build: () => {
      const cost = decisionMoney(35);
      return {
        title: '練習場の設備トラブル',
        desc: `照明とピッチの一部に不具合。今すぐ ${fmtMoney(cost)} で直せば影響はない。放置すると選手のコンディションに響くかもしれない。`,
        options: [
          { label: `すぐ修理 (-${fmtMoney(cost)})`, result: `${fmtMoney(cost)} で対応。`, apply: () => { state.club.money -= cost; } },
          { label: '応急処置でしのぐ', result: 'コンディション -4(全員)', apply: () => adjustTopCondition(-4) },
        ],
      };
    },
  },
  {
    id: 'veteranCoachPitch', weight: 2, available: () => true,
    build: () => {
      const cost = decisionMoney(30);
      return {
        title: '元選手からのコーチ売り込み',
        desc: `引退した選手が「臨時で見てやる」と連絡。謝礼 ${fmtMoney(cost)}。すぐ結果には出ないが、しばらく士気が上がる。`,
        options: [
          { label: `招く (-${fmtMoney(cost)})`, result: `${fmtMoney(cost)} を支払い。コンディション +3(全員)`, apply: () => { state.club.money -= cost; adjustTopCondition(3); } },
          { label: '丁重に断る', result: '現体制を貫いた。', apply: () => {} },
        ],
      };
    },
  },
  {
    id: 'youthScoutTrip', weight: 2, available: () => isCategoryOwned('anyYouth') || state.club.affiliates.length > 0,
    build: () => {
      const cost = decisionMoney(28);
      return {
        title: 'ユース視察に同行しないか',
        desc: `育成担当から「遠方の大会を一緒に見に行かないか」と誘い。交通費 ${fmtMoney(cost)}。人脈が広がりスカウトに追い風。`,
        options: [
          { label: `同行する (-${fmtMoney(cost)})`, result: `${fmtMoney(cost)} を拠出。評判 +3`, apply: () => { state.club.money -= cost; bumpReputation(3); } },
          { label: '任せる', result: '担当に一任した。', apply: () => {} },
        ],
      };
    },
  },
  {
    id: 'fanForum', weight: 2, available: () => true,
    build: () => ({
      title: 'サポーターとの意見交換会',
      desc: 'クラブの方針を直接説明する場を設けるか。時間は取られるが、丁寧に向き合えば支持は厚くなる。',
      options: [
        { label: '時間を取って開催', result: '評判 +4 / コンディション -2(準備に時間)', apply: () => { bumpReputation(4); adjustTopCondition(-2); } },
        { label: '書面で回答', result: '評判 +1', apply: () => bumpReputation(1) },
      ],
    }),
  },
];

function maybeRollWeeklyDecision() {
  if (state.phase !== 'season') return false;
  const round = state.currentRound;
  if (round <= 0 || round >= state.fixtures.length - 1) return false;   // 開幕直後・最終節は除外
  if (round - state.lastDecisionRound < DECISION_MIN_GAP) return false; // クールダウン
  if (Math.random() >= DECISION_ROLL_CHANCE) return false;
  const pool = WEEKLY_DECISION_POOL.filter(d => d.available());
  if (!pool.length) return false;
  const totalW = pool.reduce((s, d) => s + d.weight, 0);
  let roll = Math.random() * totalW;
  const picked = pool.find(d => (roll -= d.weight) < 0) || pool[pool.length - 1];
  // 保存できるよう id だけを持つ(表示内容は currentDecisionView() が build() で毎回組み立てる。
  // 各 build() は決定論的なので、再読込しても同じ選択肢になる)。
  state.pendingDecision = { id: picked.id };
  state.lastDecisionRound = round;
  return true;
}

// state.pendingDecision.id から現在の決断の表示内容({title, desc, options})を組み立てる。
function currentDecisionView() {
  const p = state.pendingDecision;
  if (!p) return null;
  const def = WEEKLY_DECISION_POOL.find(d => d.id === p.id);
  return def ? def.build() : null;
}

function openDecisionModal() {
  const view = currentDecisionView();
  if (!view) { state.pendingDecision = null; proceedRound(); return; }
  document.getElementById('decisionModal').classList.remove('hidden');
  renderDecisionModal();
}
function closeDecisionModal() {
  const el = document.getElementById('decisionModal');
  if (el) el.classList.add('hidden');
}
function renderDecisionModal() {
  const el = document.getElementById('decisionModal');
  const d = currentDecisionView();
  if (!el || !d) return;
  el.innerHTML = `
    <div class="match-viewer-box" style="max-width:460px;">
      <div class="mv-header">
        <div class="mv-competition">第 ${state.currentRound + 1} 節 ・ 決断</div>
        <div class="mv-teams"><span class="mv-team-me">${d.title}</span></div>
      </div>
      <div class="mv-feed" style="min-height:auto;">
        <p style="font-size:0.9rem;line-height:1.75;margin:2px 0 4px;">${d.desc}</p>
      </div>
      <div class="mv-footer" style="flex-direction:column;align-items:stretch;gap:8px;">
        ${d.options.map((o, i) => `
          <button class="primary-btn" style="width:100%;text-align:left;" onclick="Game.resolveWeeklyDecision(${i})">
            ${o.label}<br><span style="font-size:0.72rem;color:var(--text-dim);">${o.result}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}
function resolveWeeklyDecision(optIdx) {
  const d = currentDecisionView();
  if (!d) { state.pendingDecision = null; closeDecisionModal(); proceedRound(); return; }
  const opt = d.options[optIdx];
  if (!opt) return;
  opt.apply();
  addLog(`【決断】${d.title} → ${opt.label.replace(/\s*\(.*$/, '')}（${opt.result}）`, 'gold');
  state.pendingDecision = null;
  closeDecisionModal();
  proceedRound();
}

function render() {
  renderTopBar();
  const activeBtn = document.querySelector('.tab-btn.active');
  const active = activeBtn ? activeBtn.dataset.tab : 'dashboard';
  if (active === 'dashboard') renderDashboard();
  else if (active === 'table') renderTable();
  else if (active === 'power') renderPower();
  else if (active === 'cup') renderCup();
  else if (active === 'squad') renderSquad();
  else if (active === 'market') renderMarket();
  else if (active === 'facilities') renderFacilities();
  else if (active === 'coaches') renderCoaches();
  else if (active === 'academy') renderAcademy();
  else if (active === 'affiliates') renderAffiliates();
  else if (active === 'sponsors') renderSponsors();
  else if (active === 'stats') renderStats();
  renderQuickBar();
  renderMobileNav(active);
  document.getElementById('saveIndicator').textContent = '自動保存: ' + new Date().toLocaleTimeString('ja-JP');
}

// ---------- スマホ用UI(下部ナビ・メニューシート・常設アクションバー) ----------
// 表示/非表示はCSSのメディアクエリで切り替える。タブの実体は従来どおり #tabs の .tab-btn で、
// スマホ用ナビはそれを切り替えるだけ(PCとスマホで状態を二重に持たない)。

const TAB_ICONS = {
  dashboard: '🏠', table: '📊', power: '📈', cup: '🏆', squad: '👥', market: '🔄',
  facilities: '🏟️', coaches: '📋', academy: '🌱', affiliates: '🤝', sponsors: '💼', stats: '📉',
};
const MOBILE_NAV_MAIN = [
  { key: 'dashboard', label: 'ホーム' },
  { key: 'table', label: '順位表' },
  { key: 'squad', label: 'スカッド' },
  { key: 'market', label: '移籍市場' },
];

function selectTab(key) {
  const btn = document.querySelector(`.tab-btn[data-tab="${key}"]`);
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  closeMoreSheet();
  render();
  window.scrollTo(0, 0);
}

function renderMobileNav(active) {
  const inMain = MOBILE_NAV_MAIN.some(t => t.key === active);
  const activeLabel = !inMain ? (document.querySelector(`.tab-btn[data-tab="${active}"]`) || {}).textContent : '';
  document.getElementById('mobileNav').innerHTML = MOBILE_NAV_MAIN.map(t => `
    <button class="mnav-btn ${active === t.key ? 'active' : ''}" onclick="Game.selectTab('${t.key}')">
      <span class="mnav-icon">${TAB_ICONS[t.key]}</span><span class="mnav-label">${t.label}</span>
    </button>`).join('') + `
    <button class="mnav-btn ${inMain ? '' : 'active'}" onclick="Game.openMoreSheet()">
      <span class="mnav-icon">${inMain ? '☰' : TAB_ICONS[active] || '☰'}</span><span class="mnav-label">${inMain ? 'メニュー' : activeLabel}</span>
    </button>`;
}

function openMoreSheet() {
  const activeBtn = document.querySelector('.tab-btn.active');
  const active = activeBtn ? activeBtn.dataset.tab : 'dashboard';
  const items = [...document.querySelectorAll('.tab-btn')].map(b => `
    <button class="sheet-item ${b.dataset.tab === active ? 'active' : ''}" onclick="Game.selectTab('${b.dataset.tab}')">
      <span class="sheet-icon">${TAB_ICONS[b.dataset.tab] || '•'}</span><span>${b.textContent}</span>
    </button>`).join('');
  const el = document.getElementById('moreSheet');
  el.innerHTML = `
    <div class="sheet-box" onclick="event.stopPropagation()">
      <div class="sheet-handle"></div>
      <div class="sheet-title">メニュー</div>
      <div class="sheet-grid">${items}</div>
      <div class="sheet-actions">
        <button class="secondary-btn" onclick="document.getElementById('saveBtn').click(); Game.closeMoreSheet();">💾 セーブ</button>
        <button class="secondary-btn" onclick="Game.closeMoreSheet(); document.getElementById('titleBtn').click();">🚪 タイトルへ</button>
        <button class="danger-btn" onclick="Game.closeMoreSheet(); document.getElementById('newGameBtn').click();">スロット初期化</button>
      </div>
      <div class="sheet-save-note">${document.getElementById('saveIndicator').textContent}</div>
    </div>`;
  el.onclick = closeMoreSheet;
  el.classList.remove('hidden');
}
function closeMoreSheet() {
  document.getElementById('moreSheet').classList.add('hidden');
}

// どのタブを見ていても「次に進む」操作に親指ですぐ届くようにする常設バー(スマホのみ表示)。
function renderQuickBar() {
  const el = document.getElementById('quickBar');
  if (state.phase === 'season') {
    el.innerHTML = `
      <div class="qb-info"><span class="qb-main">第 ${state.currentRound + 1} / ${state.fixtures.length} 節</span><span class="qb-sub">${fmtMoney(state.club.money)}</span></div>
      <button class="primary-btn qb-btn" onclick="Game.playRound()">▶ 試合を行う</button>`;
  } else {
    const pendingReview = !!state.seasonEndReview;
    el.innerHTML = `
      <div class="qb-info"><span class="qb-main">オフシーズン</span><span class="qb-sub">${fmtMoney(state.club.money)}</span></div>
      ${pendingReview
        ? `<button class="primary-btn qb-btn" onclick="Game.openSeasonReviewModal()">シーズン結果を確認</button>`
        : `<button class="primary-btn qb-btn" onclick="Game.goToNextSeason()">次のシーズンへ ▶</button>`}`;
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 初期化・イベント ----------

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
});

document.getElementById('saveBtn').addEventListener('click', () => {
  save();
  toast('セーブしました');
  render();
});

document.getElementById('titleBtn').addEventListener('click', () => {
  save();
  showTitleScreen();
});

document.getElementById('newGameBtn').addEventListener('click', () => {
  if (confirm(`スロット${currentSlot}を初期化して新しいゲームを開始しますか？現在の進行状況は失われます。`)) {
    newGame();
    render();
    toast('スロットを初期化しました');
  }
});

window.Game = {
  playRound, debugFinishSeason, goToNextSeason, sellPlayer, buyPlayer, sellProspect,
  upgradeFacility, upgradeGround, upgradeStadium, upgradeShopStadium, upgradeShopGround, upgradeShopProduct,
  buyYouthTeam, setFacilitiesSubTab, setGroundsCategory, setStadiumCategory,
  affiliateClub, releaseAffiliate, buyAffiliatePlayer, sellPlayerToAffiliate, selectCoachSlot,
  signSponsor, releaseSponsor, setCupSubTab,
  enterSlot, resetSlot, setSquadSort, setSquadFilter, setSquadTeam,
  closeMatchViewer, skipMatchViewer, watchCupMatch, watchTopMatch, toggleLeagueLog,
  openSeasonReviewModal, closeSeasonReviewModal, setRetireeDecision, setRetireeCoachSlot,
  setPromoDecision, applySeasonEndDecisions, reorganizeTopByAbility, setLeagueViewTab,
  signAcademyCandidate, promoteProspectNow, resolveWeeklyDecision, toggleAcademyAutopilot,
  selectTab, openMoreSheet, closeMoreSheet,
};

// 読み込んだセーブデータに対する後方互換の補完・仕切り直し処理(旧バージョンのセーブを
// 現行のレギュレーション・データ構造に合わせる)。
function postLoadHousekeeping() {
  migrateClub(state.club);
  if (!state.topMatchLog) state.topMatchLog = [];
  if (state.pendingDecision === undefined) state.pendingDecision = null;
  if (state.lastDecisionRound === undefined) state.lastDecisionRound = -99;
  delete state.agencyDeals;
  if (!state.affiliateCandidates) state.affiliateCandidates = generateAffiliateCandidates();
  if (!state.affiliateRosters) state.affiliateRosters = {};
  // 旧バージョン(格・成長ボーナス導入前)の候補が残っている可能性があるため、読み込み時は
  // 常に候補リストを作り直す(移籍市場と違い、まだ契約していない「オファー」に過ぎないため)。
  state.sponsorCandidates = { general: [], youth: [], juniorYouth: [], u12: [] };
  refreshSponsorCandidatesAll();
  if (!state.academyCandidates) state.academyCandidates = { u12: [], juniorYouth: [], youth: [] };
  ['u12', 'juniorYouth', 'youth'].forEach(cat => {
    if (isCategoryOwned(cat) && !state.academyCandidates[cat].length) generateAcademyCandidates(cat);
  });
  if (state.phase === 'season' && Object.keys(state.teams).length !== TEAM_COUNT) {
    // 旧バージョン(チーム数が異なるレギュレーション)のセーブから読み込んだ場合、
    // 進行中のシーズンを現行の20チーム制で仕切り直す。
    startSeason(state.club.tier);
    addLog('レギュレーション更新のため、シーズンを現行ルール(20クラブ・38試合)で再編成しました。');
  }
  // 旧バージョン(カップ戦導入前)のセーブには今シーズンぶんのカップ戦データが無いため、
  // シーズン中であればこの時点で1回だけ生成しておく(次シーズン以降は通常どおり
  // startSeason()のたびに自動更新される)。
  // scheduleWeeksが無い場合は、日程スケジュール導入前のさらに古いリーグカップ形式の
  // セーブなので、resolveScheduledCupWeek()がクラッシュする前に仕切り直す。
  if (state.phase === 'season' && (!state.leagueCup || !state.leagueCup.scheduleWeeks)) {
    initLeagueCup();
  }
  if (state.phase === 'season' && !state.worldCup) {
    initWorldCup();
  }
  save();
}

// タイトル画面で「続きから/新しく始める」を選んだときの共通エントリーポイント。
// 既存データがあれば読み込み、無ければそのスロットで新規にゲームを開始する。
function enterSlot(slot) {
  if (loadSlotIntoState(slot)) {
    postLoadHousekeeping();
  } else {
    currentSlot = slot;
    try { localStorage.setItem(CURRENT_SLOT_KEY, String(slot)); } catch (e) { /* ignore */ }
    newGame();
  }
  showGameScreen();
  if (state.seasonEndReview) openSeasonReviewModal();
  else if (state.pendingDecision) { render(); openDecisionModal(); }
  else render();
}

// タイトル画面からスロットのデータを初期化(削除)する。
function resetSlot(slot) {
  if (!confirm(`スロット${slot}のデータを初期化します。よろしいですか？(元に戻せません)`)) return;
  deleteSlotData(slot);
  renderTitleScreen();
  toast(`スロット${slot}を初期化しました`);
}

function showTitleScreen() {
  document.getElementById('app').style.display = 'none';
  document.getElementById('titleScreen').style.display = 'flex';
  renderTitleScreen();
}
function showGameScreen() {
  document.getElementById('titleScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

function renderTitleScreen() {
  const cards = Array.from({ length: SAVE_SLOT_COUNT }, (_, i) => i + 1).map(slot => {
    const s = slotSummary(slot);
    if (s) {
      const savedText = s.savedAt ? new Date(s.savedAt).toLocaleString('ja-JP') : '不明';
      return `
        <div class="save-slot-card">
          <div class="save-slot-title">スロット ${slot}</div>
          <div class="save-slot-info">
            <div class="save-slot-club"><b>${s.clubName}</b></div>
            <div>${s.tierName} / シーズン ${s.season}</div>
            <div class="money">${fmtMoney(s.money)}</div>
            <div class="save-slot-time">最終セーブ: ${savedText}</div>
          </div>
          <div class="action-row">
            <button class="primary-btn" onclick="Game.enterSlot(${slot})">続きから</button>
            <button class="danger-btn" onclick="Game.resetSlot(${slot})">初期化</button>
          </div>
        </div>`;
    }
    return `
      <div class="save-slot-card empty">
        <div class="save-slot-title">スロット ${slot}</div>
        <div class="empty-note">空きデータ</div>
        <div class="action-row">
          <button class="primary-btn" onclick="Game.enterSlot(${slot})">新しく始める</button>
        </div>
      </div>`;
  }).join('');

  document.getElementById('titleScreen').innerHTML = `
    <div class="title-inner">
      <div class="title-logo">🏆 WORLD PYRAMID ELEVEN</div>
      <div class="title-sub">セーブデータを選んでください(3スロット)</div>
      <div class="save-slot-grid">${cards}</div>
    </div>
  `;
}

migrateLegacySave();
showTitleScreen();
