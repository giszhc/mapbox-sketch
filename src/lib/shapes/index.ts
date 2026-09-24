/* =====================================================================
 * shapes/index.ts —— 按序引入 41 个内置类型，触发它们的自注册。
 *
 * ★ 下面一律用**副作用导入**（`import './x'`）：这里要的只是「把这个模块跑一遍」——
 *   模块顶部那句 `MapboxSketch.registerType(XxxShape)` 才是目的。类型本身由文件末尾那批
 *   `export { XxxShape } from './x'` 供出去，这里再引一次绑定只会变成未使用的局部变量
 *   （`noUnusedLocals` 直接报错），对自注册毫无帮助。
 *
 * ★ import 顺序 = 类型收进注册表的顺序 = `tool.shapes` 之外各类枚举的默认顺序。
 *   `leader-coord.ts` 继承 `leader.ts`，所以 leader 必须排在它前面
 *   （ESM 按模块声明顺序求值，这里的排列天然保证了这一点）。
 *
 * ★ 最后四个（铁路 / 国界 / 高压线 / 管道）是**同一族**：都是「沿路径铺图案的线」，
 *   共用 `line-deco.ts` 那个**不注册**的抽象基类（同 `text-block.ts` 之于
 *   文字 / 富文本标注）。它们挨着排列，日后加同族的新类型也往这末尾接。
 *
 * 只想要引擎内核、自己注册类型的使用者请改用包出口 `@giszhc/mapbox-sketch/core` ——
 * 那条路径不会引入本文件，也就不会带上这 41 个内置类型。
 * ===================================================================== */
import './path';
import './polygon';
import './circle';
import './rect';
import './ellipse';
import './sector';
import './assembly';
import './image';
import './point';
import './flag';
import './flag-tri';
import './flag-wave';
import './line';
import './free-line';
import './distance';
import './area';
import './free-area';
import './leader';
import './leader-coord';
import './text';
import './rich-text';
import './curve';
import './closed-curve';
import './double-arrow';
import './fine-arrow';
import './straight-arrow';
import './assault-direction';
import './attack-arrow';
import './tailed-attack-arrow';
import './squad-combat';
import './tailed-squad-combat';
import './lune';
import './arc';
import './parallel';
import './perpendicular';
import './annulus';
import './bubble';
import './railway';
import './border';
import './powerline';
import './pipeline';

export { PathShape } from './path';
export { PolygonShape } from './polygon';
export { CircleShape } from './circle';
export { RectShape } from './rect';
export { EllipseShape } from './ellipse';
export { SectorShape } from './sector';
export { AssemblyShape } from './assembly';
export { ImageShape } from './image';
export { PointShape } from './point';
export { FlagShape } from './flag';
export { FlagTriShape } from './flag-tri';
export { FlagWaveShape } from './flag-wave';
export { LineShape } from './line';
export { FreeLineShape } from './free-line';
export { DistanceShape } from './distance';
export { AreaShape } from './area';
export { FreeAreaShape } from './free-area';
export { LeaderShape } from './leader';
export { LeaderCoordShape, dms } from './leader-coord';
export { TextShape } from './text';
export { RichTextShape } from './rich-text';
export { CurveShape } from './curve';
export { ClosedCurveShape } from './closed-curve';
export { DoubleArrowShape } from './double-arrow';
export { FineArrowShape } from './fine-arrow';
export { StraightArrowShape } from './straight-arrow';
export { AssaultDirectionShape } from './assault-direction';
export { AttackArrowShape } from './attack-arrow';
export { TailedAttackArrowShape } from './tailed-attack-arrow';
export { SquadCombatShape } from './squad-combat';
export { TailedSquadCombatShape } from './tailed-squad-combat';
export { LuneShape } from './lune';
export { ArcShape } from './arc';
export { ParallelShape } from './parallel';
export { PerpendicularShape } from './perpendicular';
export { AnnulusShape } from './annulus';
export { BubbleShape } from './bubble';
export { RailwayShape } from './railway';
export { BorderShape } from './border';
export { PowerlineShape } from './powerline';
export { PipelineShape } from './pipeline';
/* ★ `line-deco.ts`（四种「沿路径铺图案」标注的共用基类）**故意不从这里导出** ——
   同 `text-block.ts` 对文字 / 富文本标注的口径：抽象基类不进公共出口，免得
   「内部怎么搭的」变成一份要长期兼容的对外契约。第三方要用就深链引它。 */
