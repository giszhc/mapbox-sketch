/* =====================================================================
 * registry.ts —— 图形类型的「静态注册表」。
 *
 * 类型文件在自己底部调 `registerType(MyShapeType)` 完成自注册；
 * 之后创建的每个 MapboxSketch 实例都会自动带上这些类型。
 * `src/lib/shapes/index.ts` 负责按序 import 41 个内置类型，从而触发自注册。
 *
 * ★ 为什么单独一个文件：主类要读注册表、类型文件要写注册表。若注册表放在
 *   主类里，就形成 `sketch.ts ⇄ shapes/*` 的循环依赖（ESM 下会有一方拿到
 *   未初始化的绑定）。把注册表抽到零依赖的本文件，环就断了。
 * ===================================================================== */
import type { ShapeTypeCtor } from './types';

/**
 * 注册表接受的东西：**子类构造器**（常见）或**已实例化的对象**。
 *
 * 后者是 `MapboxSketch.registerType` / `addType` 也允许的形态，顺手让注册表
 * 一起支持，免得两个入口的参数类型对不上。
 * 这里只用结构化描述而不是 `MapboxShapeType` —— 本文件必须保持零依赖，
 * 才能打断 `sketch.ts ⇄ shapes/*` 的循环引用（见文件头注释）。
 */
export type ShapeTypeRegistrable =
  | ShapeTypeCtor
  | { readonly key?: string; readonly render?: unknown };

/** 已注册的类型，顺序即「类型在 UI 列表中的默认顺序」 */
const registry: ShapeTypeRegistrable[] = [];

/**
 * 读一个类型构造器的 `key`（key 是原型上的 getter，读原型即可拿到）。
 * 基类自身的 key getter 会抛错 —— 那种情况返回 null，退化为按类身份去重。
 */
function keyOf(Type: ShapeTypeRegistrable): string | null {
  try {
    const k = (Type as any).prototype && (Type as any).prototype.key;
    return typeof k === 'string' && k ? k : null;
  } catch {
    return null;
  }
}

/**
 * 静态注册一种类型（供「类型文件」自我注册）。
 * 注册进本模块的注册表，之后创建的每个工具实例都会自动带上该类型。
 *
 * **按 key 去重，后注册者胜**：这样 Vite HMR 重新求值类型模块（产生一个新的
 * 类对象）时，不会同一个 key 堆积出多份，也就不会在实例化时报「类型已注册」。
 * 同一个类被重复 register 则是无操作。
 */
export function registerType(Type: ShapeTypeRegistrable): void {
  if (typeof Type !== 'function') return;
  const key = keyOf(Type);
  if (key === null) {                       // 拿不到 key：只能按类身份去重
    if (!registry.includes(Type)) registry.push(Type);
    return;
  }
  const at = registry.findIndex((T) => T === Type || keyOf(T) === key);
  if (at < 0) { registry.push(Type); return; }
  if (registry[at] === Type) return;        // 同一个类，重复注册 → 忽略
  // 走到这里说明「同一个 key 换了新类」——开发期 HMR 重载的典型现象。
  // 生产构建下模块只求值一次，这条分支不会触发，所以无需按环境静音。
  console.warn(`[mapbox-sketch] 类型 "${key}" 被重新注册（多半是 HMR 重载），已用新定义替换旧定义。`);
  registry[at] = Type;                      // 新定义替换旧定义，保持原位置
}

/** 当前注册表快照（内部用；实例化时逐个 addType） */
export function registeredTypes(): readonly ShapeTypeRegistrable[] {
  return registry;
}
